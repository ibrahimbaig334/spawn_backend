import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PrismaService } from '../infrastructure/database/prisma.service';
import type { DecodedHookEvent } from './event-decoder';
import { accrualSourceFromUint8 } from '../protocol/protocol-constants';
import { big } from './ordinal';
import {
  dayRevenueDelta,
  ensurePoolStats,
  poolStatsAdd,
  potDelta,
  protocolDayCounter,
  protocolStatsAdd,
} from './aggregates';

/**
 * Applies decoded hook events to the data-layer tables (backend guide §2):
 * insert-only facts keyed by ordinal, upserted state, sink-maintained aggregates.
 *
 * Revenue money math is fed ONLY by accrual facts (creator_accruals /
 * protocol_accruals) — Graduated/FeesRouted/PayoutPotFunded rows are audit
 * detail, per the double-count warning in the guide.
 */

export type ProjectorContext = {
  chainId: number;
  blockNumber: bigint;
  blockHash: string;
  blockTime: Date;
  version: bigint;
  txHash: string;
  logIndex: number;
  transactionIndex: number;
  hookAddress: string;
  poolManagerAddress: string;
};

export const PROTOCOL_POOL_SENTINEL = `0x${'0'.repeat(64)}`;

@Injectable()
export class ProjectionApplier {
  private readonly logger = new Logger(ProjectionApplier.name);

  constructor(private readonly prisma: PrismaService) {}

  private ordinal(ctx: ProjectorContext): string {
    return `${ctx.blockNumber}:${ctx.logIndex}`;
  }

  async applyHookEvent(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: DecodedHookEvent,
  ): Promise<void> {
    const day = ctx.blockTime;
    switch (event.name) {
      case 'Launched': {
        await tx.launchFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            creator: event.creator,
            token: event.token,
            name: event.tokenName,
            symbol: event.symbol,
            uri: event.uri,
            totalSupply: big(event.totalSupply),
            openingLevel: event.openingLevel,
            farLevel: event.farLevel,
            configHash: event.configHash,
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        // State: tokens (metadata now arrives on-chain) + pools.
        const token = await tx.token.upsert({
          where: { chainId_token: { chainId: ctx.chainId, token: event.token } },
          create: {
            chainId: ctx.chainId,
            token: event.token,
            name: event.tokenName,
            symbol: event.symbol,
            uri: event.uri,
            source: 'INDEXER',
          },
          update: {
            name: event.tokenName,
            symbol: event.symbol,
            uri: event.uri,
          },
        });
        await tx.pool.upsert({
          where: { chainId_poolId: { chainId: ctx.chainId, poolId: event.poolId } },
          create: {
            chainId: ctx.chainId,
            poolId: event.poolId,
            status: 'bonding',
            token: event.token,
            creator: event.creator,
            totalSupply: big(event.totalSupply),
            openingLevel: event.openingLevel,
            farLevel: event.farLevel,
            payoutPlan: big(0),
            devBuyShareWad: new Prisma.Decimal(0),
            configHash: event.configHash,
            launchBlock: ctx.blockNumber,
            launchTime: ctx.blockTime,
            tokenDbId: token.id,
            revenueNftOwner: event.creator,
          },
          update: {
            token: event.token,
            creator: event.creator,
            totalSupply: big(event.totalSupply),
            openingLevel: event.openingLevel,
            farLevel: event.farLevel,
            configHash: event.configHash,
            launchBlock: ctx.blockNumber,
            launchTime: ctx.blockTime,
            tokenDbId: token.id,
            revenueNftOwner: event.creator,
          },
        });
        await ensurePoolStats(tx, ctx.chainId, event.poolId);
        await tx.protocolState.upsert({
          where: { chainId: ctx.chainId },
          create: { chainId: ctx.chainId, lastIndexedBlock: ctx.blockNumber },
          update: { lastIndexedBlock: ctx.blockNumber },
        });
        await protocolDayCounter(tx, ctx.chainId, day, 'launch_count');
        // Bind a prepared launch record (the backend relayed/created this token).
        const record = await tx.launchRecord.findFirst({
          where: {
            chainId: ctx.chainId,
            configHash: event.configHash,
            creatorWallet: event.creator,
          },
        });
        if (record) {
          await tx.launchRecord.update({
            where: { id: record.id },
            data: {
              state: 'CONFIRMED',
              tokenDbId: token.id,
              confirmedAt: ctx.blockTime,
              blockNumber: ctx.blockNumber,
            },
          });
          if (!record.ipfsUri && record.gatewayUrl) {
            await tx.token.update({
              where: { chainId_token: { chainId: ctx.chainId, token: event.token } },
              data: {
                description: record.description,
                imageUri: record.imageUri,
                ipfsUri: record.ipfsUri,
                gatewayUrl: record.gatewayUrl,
                socials: record.socials ?? undefined,
                claimedCreatorWallet: record.creatorWallet,
                source: 'API',
              },
            });
          }
        }
        return;
      }

      case 'LaunchConfigured': {
        const pool = await tx.pool.findUnique({
          where: { chainId_poolId: { chainId: ctx.chainId, poolId: event.poolId } },
        });
        if (!pool) return this.launchedLater(ctx, event.poolId);
        await tx.pool.update({
          where: { chainId_poolId: { chainId: ctx.chainId, poolId: event.poolId } },
          data: {
            payoutPlan: big(event.payoutPlan),
            devBuyShareWad: new Prisma.Decimal(event.devBuyShareWad.toString()).div(
              new Prisma.Decimal(10).pow(18),
            ),
          },
        });
        return;
      }

      case 'DevBuyExecuted': {
        await tx.devBuyFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            tokensBought: big(event.tokensBought),
            ethSpent: big(event.ethSpent),
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        return;
      }

      case 'DevBuySkipped': {
        await tx.devBuySkipFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            relayer: event.relayer,
            tokensRequested: big(event.tokensRequested),
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        return;
      }

      case 'CurvePositionsDeployed': {
        await tx.curveDeploymentFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            minted: big(event.minted),
            deployed: big(event.deployed),
            tokenSettled: big(event.tokenSettled),
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        return;
      }

      case 'BandDeployed': {
        const existing = await tx.band.findUnique({
          where: {
            chainId_poolId_bandIndex: {
              chainId: ctx.chainId,
              poolId: event.poolId,
              bandIndex: event.index,
            },
          },
        });
        await tx.band.upsert({
          where: {
            chainId_poolId_bandIndex: {
              chainId: ctx.chainId,
              poolId: event.poolId,
              bandIndex: event.index,
            },
          },
          create: {
            chainId: ctx.chainId,
            poolId: event.poolId,
            bandIndex: event.index,
            status: 'live',
            levelLower: event.levelLower,
            levelUpper: event.levelUpper,
            liquidity: big(event.liquidity),
            tokenInventory: big(event.tokenInventory),
            deployedBlock: ctx.blockNumber,
            deployedAt: ctx.blockTime,
          },
          update: {
            status: 'live',
            levelLower: event.levelLower,
            levelUpper: event.levelUpper,
            liquidity: big(event.liquidity),
            tokenInventory: big(event.tokenInventory),
            deployedBlock: ctx.blockNumber,
            deployedAt: ctx.blockTime,
          },
        });
        if (!existing) {
          await poolStatsAdd(tx, ctx.chainId, event.poolId, { bands_deployed: 1 });
        }
        return;
      }

      case 'BandSkipped': {
        await tx.bandSkipFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            bandIndex: event.index,
            carriedInventory: big(event.carriedInventory),
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        return;
      }

      case 'MilestoneHarvested': {
        await tx.milestoneHarvestFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            bandIndex: event.index,
            quoteProceeds: big(event.quoteProceeds),
            tokenResidue: big(event.tokenResidue),
            completedMilestones: event.completedMilestones,
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        await tx.band.updateMany({
          where: { chainId: ctx.chainId, poolId: event.poolId, bandIndex: event.index },
          data: {
            status: 'completed',
            completedBlock: ctx.blockNumber,
            completedAt: ctx.blockTime,
          },
        });
        await poolStatsAdd(tx, ctx.chainId, event.poolId, {
          harvest_count: 1,
          harvest_quote_total: event.quoteProceeds,
        });
        return;
      }

      case 'Graduated': {
        const pool = await tx.pool.findUnique({
          where: { chainId_poolId: { chainId: ctx.chainId, poolId: event.poolId } },
        });
        if (!pool) return this.launchedLater(ctx, event.poolId);
        await tx.graduationFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            graduationLevel: event.graduationLevel,
            quoteProceeds: big(event.quoteProceeds),
            lpSeedQuote: big(event.lpSeedQuote),
            creatorQuote: big(event.creatorQuote),
            protocolQuote: big(event.protocolQuote),
            fullRangeLiquidity: big(event.fullRangeLiquidity),
            wallLiquidity: big(event.wallLiquidity),
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        await tx.pool.update({
          where: { chainId_poolId: { chainId: ctx.chainId, poolId: event.poolId } },
          data: {
            status: 'graduated',
            graduationLevel: event.graduationLevel,
            wallLiquidity: big(event.wallLiquidity),
            fullRangeLiq: big(event.fullRangeLiquidity),
            graduationBlock: ctx.blockNumber,
            graduationTime: ctx.blockTime,
          },
        });
        await ensurePoolStats(tx, ctx.chainId, event.poolId);
        await protocolDayCounter(tx, ctx.chainId, day, 'graduation_count');
        return;
      }

      case 'PayoutPotFunded': {
        const ordinal = this.ordinal(ctx);
        await tx.payoutPotFundingFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: ordinal,
            poolId: event.poolId,
            milestoneIndex: event.milestoneIndex,
            grossQuote: big(event.grossQuote),
            serviceFee: big(event.serviceFee),
            netQuote: big(event.netQuote),
            economicVersion: event.economicVersion,
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        await tx.harvestPayoutFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: `${ordinal}:p`,
            poolId: event.poolId,
            milestoneIndex: event.milestoneIndex,
            grossQuote: big(event.grossQuote),
            serviceFee: big(event.serviceFee),
            netQuote: big(event.netQuote),
            economicVersion: event.economicVersion,
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        await potDelta(
          tx,
          ctx.chainId,
          event.poolId,
          event.netQuote,
          event.netQuote,
          event.serviceFee,
        );
        await poolStatsAdd(tx, ctx.chainId, event.poolId, { pot_funded_total: event.netQuote });
        return;
      }

      case 'PayoutPotRedeemed': {
        await tx.payoutPotRedemptionFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            amount: big(event.amount),
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        await potDelta(tx, ctx.chainId, event.poolId, -event.amount, 0n, 0n);
        return;
      }

      case 'PayoutTipPaid': {
        await tx.payoutTipFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            recipient: event.recipient,
            amount: big(event.amount),
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        await poolStatsAdd(tx, ctx.chainId, event.poolId, { tips_total: event.amount });
        return;
      }

      case 'PluginPayoutDelivered':
      case 'PluginPayoutCarried':
      case 'PluginPayoutRedirected': {
        const outcome =
          event.name === 'PluginPayoutDelivered'
            ? 'delivered'
            : event.name === 'PluginPayoutCarried'
              ? 'carried'
              : 'redirected';
        const amount =
          event.name === 'PluginPayoutDelivered'
            ? event.delivered
            : event.name === 'PluginPayoutCarried'
              ? event.carried
              : event.redirected;
        await tx.pluginPayoutFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            pluginIndex: event.pluginIndex,
            plugin: 'plugin' in event ? event.plugin : null,
            outcome,
            currentShare: big(event.currentShare),
            previousCarry: big(event.previousCarry),
            amount: big(amount),
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        if (outcome === 'delivered') {
          await poolStatsAdd(tx, ctx.chainId, event.poolId, { plugin_revenue_total: amount });
        }
        return;
      }

      case 'CreatorPathAccrued': {
        await tx.creatorPathAccrualFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            amount: big(event.amount),
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        await poolStatsAdd(tx, ctx.chainId, event.poolId, {
          creator_path_revenue_total: event.amount,
        });
        return;
      }

      case 'CreatorPathClaimed': {
        await tx.claimFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            claimType: 'creatorPath',
            holder: event.holder,
            amount: big(event.amount),
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        return;
      }

      case 'CreatorPathClaimFailed': {
        await tx.creatorPathClaimFailureFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            holder: event.holder,
            amount: big(event.amount),
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        return;
      }

      case 'CreatorAccrued': {
        const source = accrualSourceFromUint8(event.source) ?? 'SWAP_FEES';
        const sourceCol =
          source === 'CURVE_PROCEEDS'
            ? 'creator_revenue_curve'
            : source === 'MILESTONE_HARVEST'
              ? 'creator_revenue_total'
              : 'creator_revenue_swap_fees';
        await tx.creatorAccrualFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            amount: big(event.amount),
            source,
            economicVersion: event.economicVersion,
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        await poolStatsAdd(tx, ctx.chainId, event.poolId, {
          creator_revenue_total: event.amount,
          [sourceCol]: event.amount,
        });
        await dayRevenueDelta(tx, ctx.chainId, event.poolId, day, event.amount, 0n);
        return;
      }

      case 'CreatorClaimed': {
        await tx.claimFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            claimType: 'creator',
            holder: event.holder,
            amount: big(event.amount),
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        return;
      }

      case 'ProtocolAccrued': {
        const source = accrualSourceFromUint8(event.source) ?? 'SWAP_FEES';
        const sourceCol =
          source === 'CURVE_PROCEEDS'
            ? 'protocol_revenue_curve'
            : source === 'MILESTONE_HARVEST'
              ? 'protocol_revenue_harvest'
              : 'protocol_revenue_swap_fees';
        await tx.protocolAccrualFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            amount: big(event.amount),
            source,
            economicVersion: event.economicVersion,
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        await poolStatsAdd(tx, ctx.chainId, event.poolId, {
          protocol_revenue_total: event.amount,
          [sourceCol]: event.amount,
        });
        await protocolStatsAdd(tx, ctx.chainId, {
          protocol_revenue_total: event.amount,
          [sourceCol]: event.amount,
        });
        await dayRevenueDelta(tx, ctx.chainId, event.poolId, day, 0n, event.amount);
        return;
      }

      case 'ProtocolClaimed': {
        await tx.claimFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: PROTOCOL_POOL_SENTINEL,
            claimType: 'protocol',
            holder: event.recipient,
            amount: big(event.amount),
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        await protocolStatsAdd(tx, ctx.chainId, { claimed_total: event.amount });
        return;
      }

      case 'FeesCollected': {
        await tx.feeCollectionFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            caller: event.caller,
            quoteFees: big(event.quoteFees),
            tokenFees: big(event.tokenFees),
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        return;
      }

      case 'FeesRouted': {
        await tx.feeRoutingFact.create({
          data: {
            chainId: ctx.chainId,
            ordinalKey: this.ordinal(ctx),
            poolId: event.poolId,
            creatorQuote: big(event.creatorQuote),
            protocolQuote: big(event.protocolQuote),
            divertedToNextBand: big(event.divertedToNextBand),
            tokensBurned: big(event.tokensBurned),
            economicVersion: event.economicVersion,
            transactionHash: ctx.txHash,
            logIndex: ctx.logIndex,
            blockNumber: ctx.blockNumber,
            timestamp: ctx.blockTime,
          },
        });
        await poolStatsAdd(tx, ctx.chainId, event.poolId, {
          swap_fee_burned_tokens: event.tokensBurned,
        });
        return;
      }

      case 'EconomicConfigSet': {
        await tx.economicConfig.upsert({
          where: { chainId_version: { chainId: ctx.chainId, version: event.version } },
          create: {
            chainId: ctx.chainId,
            version: event.version,
            harvestServiceFeeWad: wadDecimal(event.harvestServiceFeeWad),
            quoteCreatorShareWad: wadDecimal(event.quoteCreatorShareWad),
            tokenMilestoneFundShareWad: wadDecimal(event.tokenMilestoneFundShareWad),
            effectiveBlock: ctx.blockNumber,
            effectiveAt: ctx.blockTime,
          },
          update: {
            harvestServiceFeeWad: wadDecimal(event.harvestServiceFeeWad),
            quoteCreatorShareWad: wadDecimal(event.quoteCreatorShareWad),
            tokenMilestoneFundShareWad: wadDecimal(event.tokenMilestoneFundShareWad),
            effectiveBlock: ctx.blockNumber,
            effectiveAt: ctx.blockTime,
          },
        });
        await tx.protocolState.upsert({
          where: { chainId: ctx.chainId },
          create: {
            chainId: ctx.chainId,
            economicVersion: event.version,
            lastIndexedBlock: ctx.blockNumber,
          },
          update: { economicVersion: event.version, lastIndexedBlock: ctx.blockNumber },
        });
        return;
      }

      case 'ProtocolRecipientSet': {
        await tx.protocolState.upsert({
          where: { chainId: ctx.chainId },
          create: {
            chainId: ctx.chainId,
            protocolRecipient: event.recipient,
            lastIndexedBlock: ctx.blockNumber,
          },
          update: { protocolRecipient: event.recipient, lastIndexedBlock: ctx.blockNumber },
        });
        return;
      }

      case 'TrustedOperatorSet': {
        await tx.protocolState.upsert({
          where: { chainId: ctx.chainId },
          create: {
            chainId: ctx.chainId,
            trustedOperator: event.operator,
            trustedOperatorBlock: ctx.blockNumber,
            lastIndexedBlock: ctx.blockNumber,
          },
          update: {
            trustedOperator: event.operator,
            trustedOperatorBlock: ctx.blockNumber,
            lastIndexedBlock: ctx.blockNumber,
          },
        });
        if (event.operator === '0x0000000000000000000000000000000000000000') {
          this.logger.error('trustedOperator set to zero — relayed launches are DISABLED on-chain');
        }
        return;
      }

      default:
        return;
    }
  }

  private launchedLater(ctx: ProjectorContext, poolId: string): void {
    this.logger.error(
      `event for unknown pool ${poolId} at block ${ctx.blockNumber}: Launched must precede all pool events`,
    );
    throw new Error(`unknown pool ${poolId}`);
  }
}

function wadDecimal(value: bigint): Prisma.Decimal {
  return new Prisma.Decimal(value.toString()).div(new Prisma.Decimal(10).pow(18));
}
