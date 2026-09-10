import { Inject, Injectable } from '@nestjs/common';
import { Prisma, Timeframe } from '@prisma/client';
import { APP_ENVIRONMENT } from '../../config/config.constants';
import type { Environment } from '../../config/environment';
import { CACHE_MANAGER } from '../../infrastructure/cache/cache.constants';
import { CACHE_TTL_SECONDS } from '../../infrastructure/cache/cache-ttl';
import type { DomainCachePort } from '../../infrastructure/cache/domain-cache.port';
import { PrismaService } from '../../infrastructure/database/prisma.service';

interface RankedToken {
  tokenId: string;
  name: string;
  symbol: string;
  imageUri: string;
  claimedCreatorWallet: string;
  onchain: Record<string, unknown>;
  metrics: Record<string, unknown>;
  featuredScore: number;
}

interface FeaturedCandidate {
  id: string;
  name: string;
  symbol: string;
  imageUri: string;
  claimedCreatorWallet: string;
  chain: {
    phase: string;
    contractAddress: string;
    poolId: string;
    completedCoreMilestones: number;
    completedExtraMilestones: number;
  };
  volume: Prisma.Decimal | null;
  marketCap: Prisma.Decimal | null;
  tradeCount: bigint | null;
  holderCount: bigint | null;
}

@Injectable()
export class FeaturedTokensService {
  private readonly staleAfterMs: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: DomainCachePort,
    @Inject(APP_ENVIRONMENT) environment: Environment,
  ) {
    this.staleAfterMs = environment.CHAIN_STALE_AFTER_SECONDS * 1_000;
  }

  async find(chainId: number): Promise<RankedToken[]> {
    const key = `tokens:featured:${chainId}`;
    const cached = await this.cache.get<RankedToken[]>(key);
    if (cached) return cached;
    const result = await this.prisma.$transaction(
      async (tx) => {
        const watermark = await tx.chainWatermark.findUnique({ where: { chainId } });
        if (!watermark || Date.now() - watermark.blockTime.getTime() > this.staleAfterMs) return [];
        const rows = await tx.token.findMany({
          where: {
            projections: {
              some: { chainId, projectionVersion: { lte: watermark.committedVersion } },
            },
          },
          include: {
            projections: {
              where: { chainId, projectionVersion: { lte: watermark.committedVersion } },
              take: 1,
            },
            metrics: {
              where: {
                chainId,
                timeframe: Timeframe.H24,
                projectionVersion: { lte: watermark.committedVersion },
              },
              take: 1,
            },
          },
        });
        const candidates: FeaturedCandidate[] = rows.flatMap((row) => {
          const chain = row.projections[0];
          if (!chain) return [];
          const metric = row.metrics[0];
          return [
            {
              id: row.id,
              name: row.name,
              symbol: row.symbol,
              imageUri: row.imageUri,
              claimedCreatorWallet: row.claimedCreatorWallet,
              chain,
              volume: metric?.volumeUsd ?? null,
              marketCap: metric?.marketCapUsd ?? null,
              tradeCount: metric?.tradeCount ?? null,
              holderCount: metric?.holderCount ?? null,
            },
          ];
        });
        return candidates
          .map((candidate) => this.rank(candidate, candidates))
          .sort(
            (left, right) =>
              right.featuredScore - left.featuredScore ||
              compareDecimal(right.metrics.volumeUsd, left.metrics.volumeUsd) ||
              compareDecimal(right.metrics.marketCapUsd, left.metrics.marketCapUsd) ||
              left.tokenId.localeCompare(right.tokenId),
          )
          .slice(0, 3);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.featured });
    return result;
  }

  private rank(candidate: FeaturedCandidate, population: FeaturedCandidate[]): RankedToken {
    const volume = percentile(candidate, population, (item) => item.volume);
    const marketCap = percentile(candidate, population, (item) => item.marketCap);
    const trades = percentile(candidate, population, (item) => item.tradeCount);
    const holders = percentile(candidate, population, (item) => item.holderCount);
    const progress = Math.min(
      1,
      (candidate.chain.completedCoreMilestones + candidate.chain.completedExtraMilestones) / 60,
    );
    const featuredScore = Math.round(
      1_000_000 *
        (0.35 * volume + 0.25 * marketCap + 0.2 * trades + 0.1 * holders + 0.1 * progress),
    );
    return {
      tokenId: candidate.id,
      name: candidate.name,
      symbol: candidate.symbol,
      imageUri: candidate.imageUri,
      claimedCreatorWallet: candidate.claimedCreatorWallet,
      featuredScore,
      onchain: candidate.chain,
      metrics: {
        timeframe: Timeframe.H24,
        volumeUsd: candidate.volume,
        marketCapUsd: candidate.marketCap,
        tradeCount: candidate.tradeCount,
        holderCount: candidate.holderCount,
      },
    };
  }
}

type RankValue = Prisma.Decimal | bigint | null;

function percentile(
  candidate: FeaturedCandidate,
  population: FeaturedCandidate[],
  select: (item: FeaturedCandidate) => RankValue,
): number {
  const current = select(candidate);
  if (current === null || isZero(current)) return 0;
  if (population.length <= 1) return 1;
  const below = population.reduce((count, item) => {
    const value = select(item);
    return count + (compareRankValues(value, current) < 0 ? 1 : 0);
  }, 0);
  return below / (population.length - 1);
}

function compareRankValues(left: RankValue, right: RankValue): number {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  return new Prisma.Decimal(left.toString()).comparedTo(right.toString());
}

function compareDecimal(left: unknown, right: unknown): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : -1;
  if (right === null || right === undefined) return 1;
  if (!isDecimalLike(left) || !isDecimalLike(right)) return 0;
  return new Prisma.Decimal(left.toString()).comparedTo(right.toString());
}

function isDecimalLike(value: unknown): value is Prisma.Decimal | bigint | string | number {
  return (
    value instanceof Prisma.Decimal ||
    typeof value === 'bigint' ||
    typeof value === 'string' ||
    typeof value === 'number'
  );
}

function isZero(value: Exclude<RankValue, null>): boolean {
  return new Prisma.Decimal(value.toString()).isZero();
}
