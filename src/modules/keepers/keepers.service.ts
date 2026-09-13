import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { BlockchainRegistryService } from '../../infrastructure/blockchain/blockchain-registry.service';
import { sqrtPriceAtLevel } from '../../protocol/protocol-math';
import { resolveChainId } from '../../common/chain-id';

/**
 * Keeper jobs (integration guide §7.3): the poll signals and incentives for
 * keeper-rewardable actions. All are safe to batch via Multicall3 aggregate3
 * (allowFailure=false) — empty flushes/claims are no-op successes.
 *
 * | Action                | Incentive                        | Poll signal |
 * | flushTo(pool, tipTo)  | floor 1% of the newly funded pot | pot balance > 0 (carry needs the chain view) |
 * | graduate(key)         | none                             | bonding & level >= far - 1 |
 * | collectFees(key)      | none                             | swaps since last FeesCollected |
 *
 * Gas ceilings: `hook.flushGasCeiling(poolId)` / `creatorPathGasCeiling` bound a
 * batch's worst-case gas; expose them in the response when RPC is available.
 */

@Injectable()
export class KeepersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: BlockchainRegistryService,
  ) {}

  async jobs(query: { chainId?: number; kind?: string; limit?: number }) {
    const chainId = resolveChainId(query.chainId);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const book = this.registry.hasChain(chainId) ? this.registry.book(chainId) : null;

    const pools = await this.prisma.pool.findMany({
      where: { chainId },
      include: { stats: true },
      orderBy: { launchTime: 'desc' },
      take: 500,
    });

    const jobs: KeeperJob[] = [];

    if (!query.kind || query.kind === 'flush') {
      const pots = await this.prisma.pot.findMany({
        where: { chainId, balance: { gt: 0 } },
      });
      for (const pot of pots) {
        const balance = BigInt(pot.balance.toFixed());
        jobs.push({
          kind: 'flush',
          poolId: pot.poolId,
          call: {
            to: book?.hook ?? null,
            function: 'flushTo(bytes32,address)',
            args: [pot.poolId, '<tipTo>'],
          },
          incentiveWei: (balance / 100n).toString(),
          signal: { potBalanceWei: balance.toString() },
        });
      }
    }

    if (!query.kind || query.kind === 'graduate') {
      for (const p of pools) {
        if (p.status !== 'bonding' || !p.stats) continue;
        const sqrt = BigInt(p.stats.lastPriceSqrtX96.toFixed());
        if (sqrt === 0n) continue;
        // level >= far - 1  <=>  sqrt <= sqrtPriceAtLevel(far - 1)
        if (sqrt <= sqrtPriceAtLevel(p.farLevel - 1)) {
          jobs.push({
            kind: 'graduate',
            poolId: p.poolId,
            call: {
              to: book?.hook ?? null,
              function: 'graduate((address,address,uint24,int24,address))',
              args: [p.poolId],
            },
            incentiveWei: '0',
            signal: { farLevel: p.farLevel, lastPriceSqrtX96: sqrt.toString() },
          });
        }
      }
    }

    if (!query.kind || query.kind === 'collectFees') {
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      for (const p of pools.filter(
        (x) => x.status === 'graduated' && x.stats && x.stats.lastSwapBlock > 0n,
      )) {
        const last = await this.prisma.feeCollectionFact.findFirst({
          where: { chainId, poolId: p.poolId },
          orderBy: { blockNumber: 'desc' },
          select: { blockNumber: true },
        });
        const swaps = await this.prisma.swapFact.count({
          where: {
            chainId,
            poolId: p.poolId,
            timestamp: { gte: since },
            blockNumber: { gt: last?.blockNumber ?? 0n },
          },
        });
        if (swaps > 0) {
          jobs.push({
            kind: 'collectFees',
            poolId: p.poolId,
            call: {
              to: book?.hook ?? null,
              function: 'collectFees((address,address,uint24,int24,address))',
              args: [p.poolId],
            },
            incentiveWei: '0',
            signal: { swapsSinceLastCollection: swaps },
          });
        }
      }
    }

    return {
      chainId,
      jobs: jobs.slice(0, limit),
      multicall3: book?.multicall3 ?? null,
      batchingNote:
        'flushTo routes the 1% tip to an explicit recipient so Multicall3 batches work (bare flush cannot pay a tip from a contract caller). claimCreatorPathBatch(pools) settles several pools in one redemption when one holder owns them all.',
    };
  }
}

export type KeeperJob = {
  kind: 'flush' | 'graduate' | 'collectFees';
  poolId: string;
  call: { to: string | null; function: string; args: string[] };
  incentiveWei: string;
  signal: Record<string, unknown>;
};
