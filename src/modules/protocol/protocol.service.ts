import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { BlockchainRegistryService } from '../../infrastructure/blockchain/blockchain-registry.service';
import { ProtocolReadService } from '../../infrastructure/blockchain/protocol-read.service';
import { ECONOMICS_CAPS } from '../../protocol/protocol-constants';
import { pageMeta } from '../../common/pagination/page-result';
import { DomainException } from '../../common/http/domain.exception';

/**
 * Protocol-wide reads: address book, versioned economics, plugin registry mirror,
 * governance state + operations, protocol revenue, stats, and the indexer watermark.
 */

const REVENUE_TABLES: Record<string, string> = {
  creator: 'creator_accruals',
  protocol: 'protocol_accruals',
  claims: 'claims',
  tips: 'payout_tips',
  pluginPayouts: 'plugin_payouts',
  pots: 'payout_pot_fundings',
};

@Injectable()
export class ProtocolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: BlockchainRegistryService,
    private readonly protocolReads: ProtocolReadService,
  ) {}

  private chainId(query: { chainId?: number }): number {
    return query.chainId ?? Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
  }

  addresses(query: { chainId?: number }) {
    const chainId = this.chainId(query);
    if (!this.registry.hasChain(chainId)) {
      throw new NotFoundException({
        code: 'MANIFEST_NOT_SYNCED',
        message: `no deployment manifest for chain ${chainId}`,
      });
    }
    const book = this.registry.book(chainId);
    return {
      chainId,
      hook: book.hook,
      launchSupport: book.launchSupport,
      revenueNft: book.revenueNft,
      payoutPluginRegistry: book.payoutPluginRegistry,
      protocolController: book.protocolController,
      buybackAndBurnPlugin: book.buybackAndBurnPlugin ?? null,
      poolManager: book.poolManager,
      stateView: book.stateView ?? null,
      v4Quoter: book.v4Quoter ?? null,
      multicall3: book.multicall3,
      canonicalPayoutPlan: book.canonicalPayoutPlan ?? null,
      hookSalt: book.hookSalt ?? null,
    };
  }

  async economics(query: { chainId?: number }) {
    const chainId = this.chainId(query);
    const rows = await this.prisma.economicConfig.findMany({
      where: { chainId },
      orderBy: { version: 'desc' },
      take: 20,
    });
    const state = await this.prisma.protocolState.findUnique({ where: { chainId } });
    const current = rows.find((r) => !state || r.version === state.economicVersion) ?? rows[0];
    if (!current) {
      if (this.registry.hasChain(chainId)) {
        try {
          const live = await this.protocolReads.economicConfig(chainId);
          return {
            chainId,
            current: {
              version: live.version.toString(),
              harvestServiceFeeWad: wadString(live.harvestServiceFeeWad),
              quoteCreatorShareWad: wadString(live.quoteCreatorShareWad),
              tokenMilestoneFundShareWad: wadString(live.tokenMilestoneFundShareWad),
            },
            caps: {
              harvestServiceFeeWad: { max: ECONOMICS_CAPS.maxHarvestServiceFeeWad },
              quoteCreatorShareWad: { max: ECONOMICS_CAPS.maxQuoteCreatorShareWad },
              tokenMilestoneFundShareWad: { max: ECONOMICS_CAPS.maxTokenMilestoneFundShareWad },
            },
            history: [],
            source: 'live',
          };
        } catch {
          throw new NotFoundException({
            code: 'ECONOMICS_NOT_AVAILABLE',
            message:
              'no economic config recorded and the live read failed (no RPC or protocol not deployed)',
          });
        }
      }
      throw new NotFoundException({
        code: 'ECONOMICS_NOT_AVAILABLE',
        message: 'no economic configuration recorded for this chain',
      });
    }
    return {
      chainId,
      current: {
        version: current.version.toString(),
        harvestServiceFeeWad: current.harvestServiceFeeWad.toFixed(),
        quoteCreatorShareWad: current.quoteCreatorShareWad.toFixed(),
        tokenMilestoneFundShareWad: current.tokenMilestoneFundShareWad.toFixed(),
        effectiveBlock: current.effectiveBlock.toString(),
        effectiveAt: current.effectiveAt,
      },
      caps: {
        harvestServiceFeeWad: { max: ECONOMICS_CAPS.maxHarvestServiceFeeWad },
        quoteCreatorShareWad: { max: ECONOMICS_CAPS.maxQuoteCreatorShareWad },
        tokenMilestoneFundShareWad: { max: ECONOMICS_CAPS.maxTokenMilestoneFundShareWad },
      },
      history: rows.map((r) => ({
        version: r.version.toString(),
        effectiveBlock: r.effectiveBlock.toString(),
        effectiveAt: r.effectiveAt,
      })),
      source: 'indexer',
    };
  }

  async plugins(query: { chainId?: number }) {
    const chainId = this.chainId(query);
    const rows = await this.prisma.pluginRegistryEntry.findMany({
      where: { chainId },
      orderBy: { registryIndex: 'asc' },
    });
    return {
      data: rows.map((row) => ({
        registryIndex: row.registryIndex,
        plugin: row.plugin,
        takeWad: row.takeWad.toFixed(),
        gasLimit: row.gasLimit,
        codeHash: row.codeHash,
        role: row.role,
        suspended: row.suspended,
        registeredAtBlock: row.registeredBlock.toString(),
      })),
      meta: pageMeta(1, 256, rows.length),
    };
  }

  async governance(query: { chainId?: number; status?: string }) {
    const chainId = this.chainId(query);
    const state = await this.prisma.protocolState.findUnique({ where: { chainId } });
    const ops = await this.prisma.governanceOperation.findMany({
      where: {
        chainId,
        ...(query.status ? { status: query.status as never } : {}),
      },
      orderBy: { blockTime: 'desc' },
      take: 100,
    });
    return {
      chainId,
      state: state
        ? {
            economicVersion: state.economicVersion.toString(),
            protocolRecipient: state.protocolRecipient,
            trustedOperator: state.trustedOperator,
            trustedOperatorSetBlock: state.trustedOperatorBlock?.toString() ?? null,
            administrator: state.administrator,
            pendingAdministrator: state.pendingAdministrator,
            governanceDelaySeconds: state.governanceDelaySeconds?.toString() ?? null,
          }
        : null,
      operations: ops.map((o) => ({
        operationId: o.operationId,
        action: o.action,
        status: o.status,
        readyAt: o.readyAt?.toISOString() ?? null,
        executedAtBlock: o.executedAtBlock?.toString() ?? null,
        cancelledAtBlock: o.cancelledAtBlock?.toString() ?? null,
        blockTime: o.blockTime,
      })),
    };
  }

  async revenue(query: { chainId?: number }) {
    const chainId = this.chainId(query);
    const [accruals, claims, totals] = await Promise.all([
      this.prisma.protocolAccrualFact.findMany({
        where: { chainId },
        orderBy: { blockNumber: 'desc' },
        take: 200,
      }),
      this.prisma.claimFact.findMany({
        where: { chainId, claimType: 'protocol' },
        orderBy: { blockNumber: 'desc' },
        take: 50,
      }),
      this.prisma.protocolStats.findUnique({ where: { chainId } }),
    ]);
    // Live view of the current claimable + claim-backed ledgers when RPC is up.
    let live: { protocolClaimable: string; protocolClaimBacked: string } | null = null;
    if (this.registry.hasChain(chainId)) {
      try {
        const [claimable, backed] = await Promise.all([
          this.protocolReads.protocolClaimable(chainId),
          this.protocolReads.protocolClaimBacked(chainId),
        ]);
        live = { protocolClaimable: claimable.toString(), protocolClaimBacked: backed.toString() };
      } catch {
        live = null;
      }
    }
    return {
      chainId,
      totals: totals
        ? {
            accrued: totals.protocolRevenueTotal.toFixed(),
            curve: totals.protocolRevenueCurve.toFixed(),
            swapFees: totals.protocolRevenueSwapFees.toFixed(),
            harvestFees: totals.protocolRevenueHarvest.toFixed(),
            claimed: totals.claimedTotal.toFixed(),
          }
        : null,
      live,
      accruals: accruals.map((r) => ({
        poolId: r.poolId,
        source: r.source,
        amountWei: r.amount.toFixed(),
        economicVersion: r.economicVersion.toString(),
        transactionHash: r.transactionHash,
        blockNumber: r.blockNumber.toString(),
        timestamp: r.timestamp,
      })),
      claims: claims.map((r) => ({
        recipient: r.holder,
        amountWei: r.amount.toFixed(),
        transactionHash: r.transactionHash,
        blockNumber: r.blockNumber.toString(),
        timestamp: r.timestamp,
      })),
    };
  }

  async stats(query: { chainId?: number }) {
    const chainId = this.chainId(query);
    const days = await this.prisma.protocolDayStats.findMany({
      where: { chainId },
      orderBy: { day: 'desc' },
      take: 60,
    });
    const leaderboard = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      'SELECT * FROM leaderboard_daily ORDER BY "daily_volume_eth" DESC LIMIT 20',
    );
    return {
      chainId,
      daily: days.map((d) => ({
        day: d.day,
        buyVolumeEth: d.buyVolumeEth.toFixed(),
        sellVolumeEth: d.sellVolumeEth.toFixed(),
        swapCount: d.swapCount.toString(),
        creatorRevenueEth: d.creatorRevenueEth.toFixed(),
        protocolRevenueEth: d.protocolRevenueEth.toFixed(),
        harvestFeesEth: d.harvestFeesEth.toFixed(),
        graduationCount: d.graduationCount,
        launchCount: d.launchCount,
      })),
      leaderboard,
    };
  }

  async watermark(query: { chainId?: number }) {
    const chainId = this.chainId(query);
    const row = await this.prisma.chainWatermark.findUnique({ where: { chainId } });
    if (!row) {
      throw new NotFoundException({
        code: 'WATERMARK_NOT_FOUND',
        message: 'the indexer has not committed any block yet',
      });
    }
    const state = await this.prisma.protocolState.findUnique({ where: { chainId } });
    return {
      chainId,
      committedVersion: row.committedVersion.toString(),
      blockNumber: row.blockNumber.toString(),
      blockHash: row.blockHash,
      blockTime: row.blockTime.toISOString(),
      lastIndexedBlock: state?.lastIndexedBlock?.toString() ?? null,
      trustedOperator: state?.trustedOperator ?? null,
    };
  }

  async revenueHistory(query: {
    chainId?: number;
    kind?: string;
    poolId?: string;
    holder?: string;
    limit?: number;
  }) {
    const chainId = this.chainId(query);
    const kind = query.kind ?? 'protocol';
    const table = REVENUE_TABLES[kind];
    if (!table)
      throw new DomainException(
        400,
        'INVALID_KIND',
        `kind must be one of ${Object.keys(REVENUE_TABLES).join(', ')}`,
      );
    const conds: string[] = [`"chain_id" = ${chainId}`];
    if (query.poolId) conds.push(`"pool_id" = '${query.poolId.toLowerCase()}'`);
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const rows = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM ${table} WHERE ${conds.join(' AND ')} ORDER BY "block_number" DESC, "log_index" DESC LIMIT ${limit}`,
    );
    return { chainId, kind, data: rows };
  }
}

function wadString(value: bigint): string {
  const whole = value / 10n ** 18n;
  const frac = (value % 10n ** 18n).toString().padStart(18, '0');
  return `${whole.toString()}.${frac}`;
}
