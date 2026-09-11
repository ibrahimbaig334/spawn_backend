import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PrismaService } from '../infrastructure/database/prisma.service';
import { bigToDecimal, decimalToBig, wadToDecimal } from './decimal-utils';
import type { DecodedHookEvent } from './event-decoder';
import { ACCRUAL_SOURCES } from '../protocol/protocol-constants';

/**
 * Event-to-projection applier. Runs inside the per-block transaction so a block's
 * effects are atomic with its receipt and watermark commit.
 *
 * Key protocol invariants encoded here:
 * - `level = -tick` conversion happens exactly once, at this boundary.
 * - Milestone geometry is taken from BandDeployed events verbatim (levelLower/
 *   levelUpper), never recomputed, per the integration guide.
 * - Cumulative event fields (deployed bitmaps, completedMilestones) are snapshots;
 *   they are stored verbatim, never accumulated.
 * - Every revenue-relevant event lands in `revenue_events` for the claim/payout
 *   history endpoints, with economicVersion attribution.
 */

export type ProjectorContext = {
  chainId: number;
  blockNumber: bigint;
  blockHash: string;
  blockTime: Date;
  version: bigint;
  txHash: string;
  logIndex: number;
  hookAddress: string;
  poolManagerAddress: string;
};

type PoolRef = { tokenId: string; poolId: string };

@Injectable()
export class ProjectionApplier {
  private readonly logger = new Logger(ProjectionApplier.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Resolves a poolId -> token projection row. */
  private async pool(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    poolId: string,
  ): Promise<PoolRef | null> {
    const state = await tx.tokenChainState.findUnique({
      where: { chainId_poolId: { chainId: ctx.chainId, poolId } },
      select: { tokenId: true, poolId: true },
    });
    return state ?? null;
  }

  private async requirePool(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    poolId: string,
  ): Promise<PoolRef> {
    const ref = await this.pool(tx, ctx, poolId);
    if (!ref) {
      // A hook event for an unknown pool can only happen if the indexer missed the
      // Launched event (e.g. started mid-stream). Log loudly; boot backfill covers it.
      this.logger.warn(`hook event for unknown pool ${poolId} at block ${ctx.blockNumber}`);
      throw new Error(`unknown pool ${poolId}`);
    }
    return ref;
  }

  /** Applies one decoded hook event. Throws to abort the block on inconsistency. */
  async applyHookEvent(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: DecodedHookEvent,
  ): Promise<void> {
    switch (event.name) {
      case 'Launched':
        return this.applyLaunched(tx, ctx, event);
      case 'LaunchConfigured':
        return this.applyLaunchConfigured(tx, ctx, event);
      case 'DevBuyExecuted':
      case 'DevBuySkipped':
        return this.applyDevBuy(tx, ctx, event);
      case 'CurvePositionsDeployed':
        return this.applyCurvePositionsDeployed(tx, ctx, event);
      case 'BandDeployed':
        return this.applyBandDeployed(tx, ctx, event);
      case 'BandSkipped':
        return this.applyBandSkipped(tx, ctx, event);
      case 'MilestoneHarvested':
        return this.applyMilestoneHarvested(tx, ctx, event);
      case 'Graduated':
        return this.applyGraduated(tx, ctx, event);
      case 'PayoutPotFunded':
        return this.applyPayoutPotFunded(tx, ctx, event);
      case 'PayoutPotRedeemed':
        return this.applyPayoutPotRedeemed(tx, ctx, event);
      case 'PayoutTipPaid':
        return this.applyPayoutTipPaid(tx, ctx, event);
      case 'PluginPayoutDelivered':
      case 'PluginPayoutCarried':
      case 'PluginPayoutRedirected':
        return this.applyPluginPayout(tx, ctx, event);
      case 'CreatorPathAccrued':
        return this.applyCreatorPathAccrued(tx, ctx, event);
      case 'CreatorPathClaimed':
      case 'CreatorPathClaimFailed':
        return this.applyCreatorPathClaim(tx, ctx, event);
      case 'CreatorAccrued':
        return this.applyCreatorAccrued(tx, ctx, event);
      case 'CreatorClaimed':
        return this.applyCreatorClaimed(tx, ctx, event);
      case 'ProtocolAccrued':
        return this.applyProtocolAccrued(tx, ctx, event);
      case 'ProtocolClaimed':
        return this.applyProtocolClaimed(tx, ctx, event);
      case 'FeesCollected':
        return this.applyFeesCollected(tx, ctx, event);
      case 'FeesRouted':
        return this.applyFeesRouted(tx, ctx, event);
      case 'EconomicConfigSet':
        return this.applyEconomicConfigSet(tx, ctx, event);
      case 'ProtocolRecipientSet':
        return; // tracked via governance module reads; no projection row needed
      default:
        return;
    }
  }

  private baseState(ctx: ProjectorContext) {
    return {
      projectionVersion: ctx.version,
      sourceBlockNumber: ctx.blockNumber,
      sourceBlockHash: ctx.blockHash,
      sourceBlockTime: ctx.blockTime,
    };
  }

  private async applyLaunched(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'Launched' }>,
  ): Promise<void> {
    // Match an offchain token row by (chainId, configHash) when the launch flowed
    // through the backend; otherwise create a bare onchain-only row.
    let token = await tx.token.findFirst({
      where: { chainId: ctx.chainId, configHash: event.configHash },
    });
    if (!token) {
      const creatorProfile = await tx.profile.upsert({
        where: { walletAddress: event.creator },
        create: { walletAddress: event.creator },
        update: {},
      });
      void creatorProfile;
      token = await tx.token.create({
        data: {
          chainId: ctx.chainId,
          claimedCreatorWallet: event.creator,
          name: 'Unknown', // refreshed from the ERC-20 below
          symbol: 'UNKNOWN',
          description: '',
          imageUri: '',
          ipfsUri: '',
          gatewayUrl: '',
          configHash: event.configHash,
        },
      });
    }

    const decimals = 18; // MilestoneToken is a fixed 18-decimal ERC20
    await tx.tokenChainState.create({
      data: {
        tokenId: token.id,
        chainId: ctx.chainId,
        phase: 'BONDING_CURVE',
        contractAddress: event.token,
        poolId: event.poolId,
        launchCreatorWallet: event.creator,
        totalSupply: bigToDecimal(event.totalSupply),
        currentSupply: bigToDecimal(event.totalSupply),
        decimals,
        openingLevel: event.openingLevel,
        farLevel: event.farLevel,
        configHash: event.configHash,
        launchedAt: ctx.blockTime,
        payoutPlan: new Prisma.Decimal(0),
        devBuyShareWad: new Prisma.Decimal(0),
        ...this.baseState(ctx),
      },
    });
  }

  private async applyLaunchConfigured(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'LaunchConfigured' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    await tx.tokenChainState.update({
      where: { tokenId: pool.tokenId },
      data: {
        payoutPlan: bigToDecimal(event.payoutPlan),
        devBuyShareWad: wadToDecimal(event.devBuyShareWad),
        ...this.baseState(ctx),
      },
    });
  }

  private async applyDevBuy(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'DevBuyExecuted' | 'DevBuySkipped' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    await tx.revenueEvent.create({
      data: {
        chainId: ctx.chainId,
        tokenId: pool.tokenId,
        poolId: event.poolId,
        kind: event.name,
        walletAddress: event.name === 'DevBuySkipped' ? event.relayer : undefined,
        amountRaw: bigToDecimal(
          event.name === 'DevBuyExecuted' ? event.ethSpent : event.tokensRequested,
        ),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
    });
  }

  private async applyCurvePositionsDeployed(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'CurvePositionsDeployed' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    await tx.tokenChainState.update({
      where: { tokenId: pool.tokenId },
      data: {
        curveDeployed: event.deployed, // cumulative snapshot, stored verbatim
        ...this.baseState(ctx),
      },
    });
  }

  private async applyBandDeployed(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'BandDeployed' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    const state = await tx.tokenChainState.findUnique({
      where: { tokenId: pool.tokenId },
    });
    if (!state) throw new Error(`state missing for pool ${event.poolId}`);
    const kind = event.index < state.coreBandCount ? 'CORE' : 'EXTENSION';
    await tx.milestone.upsert({
      where: {
        tokenId_chainId_kind_index: {
          tokenId: pool.tokenId,
          chainId: ctx.chainId,
          kind,
          index: event.index,
        },
      },
      create: {
        tokenId: pool.tokenId,
        chainId: ctx.chainId,
        kind,
        index: event.index,
        state: 'DEPLOYED',
        levelLower: event.levelLower,
        levelUpper: event.levelUpper,
        liquidity: bigToDecimal(event.liquidity),
        tokenInventoryRaw: bigToDecimal(event.tokenInventory),
        tokenRemainingRaw: bigToDecimal(event.tokenInventory),
        deployedAt: ctx.blockTime,
        ...this.baseState(ctx),
      },
      update: {
        state: 'DEPLOYED',
        levelLower: event.levelLower,
        levelUpper: event.levelUpper,
        liquidity: bigToDecimal(event.liquidity),
        tokenInventoryRaw: bigToDecimal(event.tokenInventory),
        tokenRemainingRaw: bigToDecimal(event.tokenInventory),
        deployedAt: ctx.blockTime,
        ...this.baseState(ctx),
      },
    });
    await tx.tokenChainState.update({
      where: { tokenId: pool.tokenId },
      data: {
        deployedBands: bigToDecimal(bitSet(state.deployedBands, event.index)),
        feeFundedBandsCreated:
          kind === 'EXTENSION' ? state.feeFundedBandsCreated + 1 : state.feeFundedBandsCreated,
        ...this.baseState(ctx),
      },
    });
  }

  private async applyBandSkipped(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'BandSkipped' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    const state = await tx.tokenChainState.findUnique({
      where: { tokenId: pool.tokenId },
    });
    if (!state) throw new Error(`state missing for pool ${event.poolId}`);
    const kind = event.index < state.coreBandCount ? 'CORE' : 'EXTENSION';
    await tx.milestone.upsert({
      where: {
        tokenId_chainId_kind_index: {
          tokenId: pool.tokenId,
          chainId: ctx.chainId,
          kind,
          index: event.index,
        },
      },
      create: {
        tokenId: pool.tokenId,
        chainId: ctx.chainId,
        kind,
        index: event.index,
        state: 'SKIPPED',
        levelLower: 0,
        levelUpper: 0,
        tokenInventoryRaw: new Prisma.Decimal(0),
        skippedAt: ctx.blockTime,
        ...this.baseState(ctx),
      },
      update: {
        state: 'SKIPPED',
        skippedAt: ctx.blockTime,
        ...this.baseState(ctx),
      },
    });
    await tx.tokenChainState.update({
      where: { tokenId: pool.tokenId },
      data: {
        carriedInventory: bigToDecimal(event.carriedInventory), // post-skip total snapshot
        ...this.baseState(ctx),
      },
    });
  }

  private async applyMilestoneHarvested(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'MilestoneHarvested' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    const state = await tx.tokenChainState.findUnique({
      where: { tokenId: pool.tokenId },
    });
    if (!state) throw new Error(`state missing for pool ${event.poolId}`);
    const kind = event.index < state.coreBandCount ? 'CORE' : 'EXTENSION';
    await tx.milestone.updateMany({
      where: {
        tokenId: pool.tokenId,
        chainId: ctx.chainId,
        kind,
        index: event.index,
      },
      data: {
        state: 'HARVESTED',
        quoteProceedsRaw: bigToDecimal(event.quoteProceeds),
        tokenRemainingRaw: new Prisma.Decimal(0),
        tokenInventoryRaw: bigToDecimal(event.tokenResidue),
        harvestedAt: ctx.blockTime,
        ...this.baseState(ctx),
      },
    });
    const completedExtension =
      kind === 'EXTENSION'
        ? state.completedExtensionMilestones + 1
        : state.completedExtensionMilestones;
    await tx.tokenChainState.update({
      where: { tokenId: pool.tokenId },
      data: {
        completedBands: bigToDecimal(bitSet(state.completedBands, event.index)),
        completedMilestones: event.completedMilestones, // cumulative snapshot
        completedExtensionMilestones: completedExtension,
        ...this.baseState(ctx),
      },
    });
  }

  private async applyGraduated(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'Graduated' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    await tx.tokenChainState.update({
      where: { tokenId: pool.tokenId },
      data: {
        phase: 'GRADUATED',
        graduatedAt: ctx.blockTime,
        graduationLevel: event.graduationLevel, // live level observed; anchors band geometry
        ...this.baseState(ctx),
      },
    });
    // The 55/5 split accruals arrive as CreatorAccrued/ProtocolAccrued events with
    // source=CURVE_PROCEEDS in the same tx; handled by their own appliers.
    await tx.revenueEvent.create({
      data: {
        chainId: ctx.chainId,
        tokenId: pool.tokenId,
        poolId: event.poolId,
        kind: 'Graduated',
        amountRaw: bigToDecimal(event.quoteProceeds),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
    });
  }

  private async applyPayoutPotFunded(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'PayoutPotFunded' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    const state = await tx.tokenChainState.findUnique({
      where: { tokenId: pool.tokenId },
    });
    if (!state) throw new Error(`state missing for pool ${event.poolId}`);
    await tx.tokenChainState.update({
      where: { tokenId: pool.tokenId },
      data: {
        payoutPot: { increment: bigToDecimal(event.netQuote) },
        payoutPotFundedCount: { increment: 1 },
        ...this.baseState(ctx),
      },
    });
    // Milestone harvest detail (per-index service fee/net attribution).
    const kind = event.milestoneIndex < state.coreBandCount ? 'CORE' : 'EXTENSION';
    await tx.milestone.updateMany({
      where: { tokenId: pool.tokenId, chainId: ctx.chainId, kind, index: event.milestoneIndex },
      data: {
        grossHarvestRaw: bigToDecimal(event.grossQuote),
        serviceFeeRaw: bigToDecimal(event.serviceFee),
        netPotRaw: bigToDecimal(event.netQuote),
        economicVersion: event.economicVersion,
        ...this.baseState(ctx),
      },
    });
    await tx.revenueEvent.create({
      data: {
        chainId: ctx.chainId,
        tokenId: pool.tokenId,
        poolId: event.poolId,
        milestoneIndex: event.milestoneIndex,
        kind: 'PayoutPotFunded',
        source: 'MILESTONE_HARVEST',
        economicVersion: event.economicVersion,
        amountRaw: bigToDecimal(event.netQuote),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
    });
  }

  private async applyPayoutPotRedeemed(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'PayoutPotRedeemed' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    await tx.tokenChainState.update({
      where: { tokenId: pool.tokenId },
      data: {
        payoutPot: { decrement: bigToDecimal(event.amount) },
        ...this.baseState(ctx),
      },
    });
  }

  private async applyPayoutTipPaid(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'PayoutTipPaid' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    await tx.revenueEvent.create({
      data: {
        chainId: ctx.chainId,
        tokenId: pool.tokenId,
        poolId: event.poolId,
        kind: 'PayoutTipPaid',
        walletAddress: event.flusher,
        amountRaw: bigToDecimal(event.amount),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
    });
  }

  private async applyPluginPayout(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<
      DecodedHookEvent,
      { name: 'PluginPayoutDelivered' | 'PluginPayoutCarried' | 'PluginPayoutRedirected' }
    >,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    const state = await tx.tokenChainState.findUnique({
      where: { tokenId: pool.tokenId },
    });
    if (!state) throw new Error(`state missing for pool ${event.poolId}`);

    if (event.name === 'PluginPayoutCarried') {
      await tx.tokenChainState.update({
        where: { tokenId: pool.tokenId },
        data: {
          pluginCarryBitmap: bigToDecimal(bitSet(state.pluginCarryBitmap, event.pluginIndex)),
          ...this.baseState(ctx),
        },
      });
    } else if (event.name === 'PluginPayoutDelivered' || event.name === 'PluginPayoutRedirected') {
      const bitmap = toBig(state.pluginCarryBitmap);
      const carryWasSet = bitTest(bitmap, event.pluginIndex);
      const nextBitmap = carryWasSet ? bitClear(bitmap, event.pluginIndex) : bitmap;
      await tx.tokenChainState.update({
        where: { tokenId: pool.tokenId },
        data: {
          pluginCarryBitmap: bigToDecimal(nextBitmap),
          ...this.baseState(ctx),
        },
      });
    }

    const amount =
      event.name === 'PluginPayoutDelivered'
        ? event.delivered
        : event.name === 'PluginPayoutCarried'
          ? event.carried
          : event.redirected;
    await tx.revenueEvent.create({
      data: {
        chainId: ctx.chainId,
        tokenId: pool.tokenId,
        poolId: event.poolId,
        pluginIndex: event.pluginIndex,
        kind: event.name,
        outcome:
          event.name === 'PluginPayoutDelivered'
            ? 'DELIVERED'
            : event.name === 'PluginPayoutCarried'
              ? 'CARRIED'
              : 'REDIRECTED',
        amountRaw: bigToDecimal(amount),
        carriedAmountRaw: bigToDecimal(event.previousCarry),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
    });
  }

  private async applyCreatorPathAccrued(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'CreatorPathAccrued' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    await tx.tokenChainState.update({
      where: { tokenId: pool.tokenId },
      data: {
        creatorPathClaimable: { increment: bigToDecimal(event.amount) },
        ...this.baseState(ctx),
      },
    });
    await tx.revenueEvent.create({
      data: {
        chainId: ctx.chainId,
        tokenId: pool.tokenId,
        poolId: event.poolId,
        kind: 'CreatorPathAccrued',
        amountRaw: bigToDecimal(event.amount),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
    });
  }

  private async applyCreatorPathClaim(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'CreatorPathClaimed' | 'CreatorPathClaimFailed' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    if (event.name === 'CreatorPathClaimed') {
      await tx.tokenChainState.update({
        where: { tokenId: pool.tokenId },
        data: {
          creatorPathClaimable: { decrement: bigToDecimal(event.amount) },
          ...this.baseState(ctx),
        },
      });
    }
    await tx.revenueEvent.create({
      data: {
        chainId: ctx.chainId,
        tokenId: pool.tokenId,
        poolId: event.poolId,
        kind: event.name,
        walletAddress: event.holder,
        amountRaw: bigToDecimal(event.amount),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
    });
  }

  private async applyCreatorAccrued(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'CreatorAccrued' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    await tx.tokenChainState.update({
      where: { tokenId: pool.tokenId },
      data: {
        directCreatorClaimable: { increment: bigToDecimal(event.amount) },
        ...this.baseState(ctx),
      },
    });
    await tx.revenueEvent.create({
      data: {
        chainId: ctx.chainId,
        tokenId: pool.tokenId,
        poolId: event.poolId,
        source: accrualSource(event.source),
        kind: 'CreatorAccrued',
        economicVersion: event.economicVersion,
        amountRaw: bigToDecimal(event.amount),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
    });
  }

  private async applyCreatorClaimed(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'CreatorClaimed' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    await tx.tokenChainState.update({
      where: { tokenId: pool.tokenId },
      data: {
        directCreatorClaimable: { decrement: bigToDecimal(event.amount) },
        ...this.baseState(ctx),
      },
    });
    await tx.revenueEvent.create({
      data: {
        chainId: ctx.chainId,
        tokenId: pool.tokenId,
        poolId: event.poolId,
        kind: 'CreatorClaimed',
        walletAddress: event.holder,
        amountRaw: bigToDecimal(event.amount),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
    });
  }

  private async applyProtocolAccrued(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'ProtocolAccrued' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    await tx.revenueEvent.create({
      data: {
        chainId: ctx.chainId,
        tokenId: pool.tokenId,
        poolId: event.poolId,
        source: accrualSource(event.source),
        kind: 'ProtocolAccrued',
        economicVersion: event.economicVersion,
        amountRaw: bigToDecimal(event.amount),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
    });
  }

  private async applyProtocolClaimed(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'ProtocolClaimed' }>,
  ): Promise<void> {
    await tx.revenueEvent.create({
      data: {
        chainId: ctx.chainId,
        poolId: '0x' + '0'.repeat(64), // protocol-global
        kind: 'ProtocolClaimed',
        walletAddress: event.recipient,
        amountRaw: bigToDecimal(event.amount),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
    });
  }

  private async applyFeesCollected(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'FeesCollected' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    await tx.revenueEvent.create({
      data: {
        chainId: ctx.chainId,
        tokenId: pool.tokenId,
        poolId: event.poolId,
        kind: 'FeesCollected',
        walletAddress: event.caller,
        amountRaw: bigToDecimal(event.quoteFees),
        carriedAmountRaw: bigToDecimal(event.tokenFees),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
    });
  }

  private async applyFeesRouted(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'FeesRouted' }>,
  ): Promise<void> {
    const pool = await this.requirePool(tx, ctx, event.poolId);
    await tx.tokenChainState.update({
      where: { tokenId: pool.tokenId },
      data: {
        directCreatorClaimable: { increment: bigToDecimal(event.creatorQuote) },
        milestoneFundAccrued: { increment: bigToDecimal(event.divertedToNextBand) },
        ...this.baseState(ctx),
      },
    });
    await tx.revenueEvent.create({
      data: {
        chainId: ctx.chainId,
        tokenId: pool.tokenId,
        poolId: event.poolId,
        source: 'SWAP_FEES',
        kind: 'FeesRouted',
        economicVersion: event.economicVersion,
        amountRaw: bigToDecimal(event.creatorQuote),
        carriedAmountRaw: bigToDecimal(event.divertedToNextBand),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
    });
  }

  private async applyEconomicConfigSet(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedHookEvent, { name: 'EconomicConfigSet' }>,
  ): Promise<void> {
    await tx.economicConfigRecord.upsert({
      where: { chainId: ctx.chainId },
      create: {
        chainId: ctx.chainId,
        version: event.version,
        harvestServiceFeeWad: wadToDecimal(event.harvestServiceFeeWad),
        quoteCreatorShareWad: wadToDecimal(event.quoteCreatorShareWad),
        tokenMilestoneFundShareWad: wadToDecimal(event.tokenMilestoneFundShareWad),
        activatedAtBlock: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
      update: {
        version: event.version,
        harvestServiceFeeWad: wadToDecimal(event.harvestServiceFeeWad),
        quoteCreatorShareWad: wadToDecimal(event.quoteCreatorShareWad),
        tokenMilestoneFundShareWad: wadToDecimal(event.tokenMilestoneFundShareWad),
        activatedAtBlock: ctx.blockNumber,
        blockTime: ctx.blockTime,
      },
    });
  }
}

function bitSet(bitmap: BitmapInput, index: number): bigint {
  const value = toBig(bitmap);
  return value | (1n << BigInt(index));
}

function bitClear(bitmap: BitmapInput, index: number): bigint {
  const value = toBig(bitmap);
  return value & ~(1n << BigInt(index));
}

function bitTest(bitmap: BitmapInput, index: number): boolean {
  const value = toBig(bitmap);
  return (value & (1n << BigInt(index))) !== 0n;
}

type DecimalLike = { toFixed(): string };
type BitmapInput = bigint | DecimalLike;

function toBig(value: BitmapInput): bigint {
  if (typeof value === 'bigint') return value;
  // Decimal(78,0).toFixed() yields the exact integer string (no exponent).
  return decimalToBig(value);
}

function accrualSource(value: number): 'CURVE_PROCEEDS' | 'SWAP_FEES' | 'MILESTONE_HARVEST' {
  const name = ACCRUAL_SOURCES[value];
  if (!name) throw new Error(`unknown accrual source ${value}`);
  return name;
}
