import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { ProtocolReadService } from '../../infrastructure/blockchain/protocol-read.service';
import { BlockchainRegistryService } from '../../infrastructure/blockchain/blockchain-registry.service';
import { pageMeta } from '../../common/pagination/page-result';
import { decimalToBig } from '../../indexer/decimal-utils';

/**
 * Keeper jobs (integration guide §7.3): the poll signals and incentives for
 * keeper-rewardable actions.
 *
 * | Action | Incentive | Poll signal |
 * | flush(poolId) | floor 1% of the new pot | payoutPot > 0 OR carryBitmap != 0 |
 * | collectFees(key) | none | simulate or track FeesCollected-absence |
 * | graduate(key) | none | phase == BONDING_CURVE AND level >= farLevel - 1 |
 *
 * All three entry points are safe to batch with Multicall3 aggregate3
 * (allowFailure=false): zero-value claims and empty flushes are no-op successes.
 */

@Injectable()
export class KeepersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly protocolReads: ProtocolReadService,
    private readonly registry: BlockchainRegistryService,
  ) {}

  async jobs(query: {
    chainId?: number;
    kind?: string;
    limit?: number;
  }): Promise<KeeperJobsPresenter> {
    const chainId = query.chainId ?? Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const book = this.registry.hasChain(chainId) ? this.registry.book(chainId) : null;

    const committed = await this.prisma.chainWatermark.findUnique({ where: { chainId } });
    if (!committed) {
      return {
        chainId,
        jobs: [],
        meta: pageMeta(1, limit, 0),
        multicall3: book?.multicall3 ?? null,
      };
    }

    const states = await this.prisma.tokenChainState.findMany({
      where: {
        chainId,
        projectionVersion: { lte: committed.committedVersion },
      },
      orderBy: { sourceBlockTime: 'desc' },
      take: 500,
    });

    const jobs: KeeperJob[] = [];

    if (!query.kind || query.kind === 'flush') {
      for (const state of states) {
        const pot = decimalToBig(state.payoutPot);
        const carry = decimalToBig(state.pluginCarryBitmap);
        if (pot > 0n || carry !== 0n) {
          jobs.push({
            kind: 'flush',
            poolId: state.poolId,
            tokenId: state.tokenId,
            call: { to: book?.hook ?? null, function: 'flush(bytes32)', args: [state.poolId] },
            incentiveWei: (pot / 100n).toString(), // floor 1% of the new pot
            signal: { payoutPotWei: pot.toString(), carryBitmap: carry.toString() },
          });
        }
      }
    }

    if (!query.kind || query.kind === 'graduate') {
      for (const state of states) {
        if (state.phase !== 'BONDING_CURVE') continue;
        const level = state.lastPriceLevel ?? state.openingLevel;
        if (level >= state.farLevel - 1) {
          jobs.push({
            kind: 'graduate',
            poolId: state.poolId,
            tokenId: state.tokenId,
            call: {
              to: book?.hook ?? null,
              function: 'graduate((address,address,uint24,int24,address))',
              args: [state.poolId],
            },
            incentiveWei: '0',
            signal: { level, farLevel: state.farLevel },
          });
        }
      }
    }

    if (!query.kind || query.kind === 'collectFees') {
      // collectFees has no cheap on-chain signal; expose graduated pools with
      // trade activity since the last FeesCollected event as candidates.
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const graduated = states.filter((s) => s.phase === 'GRADUATED' && s.sourceBlockTime >= since);
      for (const state of graduated) {
        const lastCollection = await this.prisma.revenueEvent.findFirst({
          where: { chainId, poolId: state.poolId, kind: 'FeesCollected' },
          orderBy: { blockNumber: 'desc' },
        });
        const swapsSince = await this.prisma.trade.count({
          where: {
            chainId,
            tokenId: state.tokenId,
            blockNumber: { gt: lastCollection?.blockNumber ?? 0n },
          },
        });
        if (swapsSince > 0) {
          jobs.push({
            kind: 'collectFees',
            poolId: state.poolId,
            tokenId: state.tokenId,
            call: {
              to: book?.hook ?? null,
              function: 'collectFees((address,address,uint24,int24,address))',
              args: [state.poolId],
            },
            incentiveWei: '0',
            signal: { swapsSinceLastCollection: swapsSince },
          });
        }
      }
    }

    return {
      chainId,
      jobs: jobs.slice(0, limit),
      meta: pageMeta(1, limit, jobs.length),
      multicall3: book?.multicall3 ?? null,
    };
  }
}

export type KeeperJob = {
  kind: 'flush' | 'graduate' | 'collectFees';
  poolId: string;
  tokenId: string;
  call: { to: string | null; function: string; args: string[] };
  incentiveWei: string;
  signal: Record<string, unknown>;
};

export type KeeperJobsPresenter = {
  chainId: number;
  jobs: KeeperJob[];
  meta: { page: number; limit: number; total: number; totalPages: number; hasNext: boolean };
  multicall3: string | null;
};
