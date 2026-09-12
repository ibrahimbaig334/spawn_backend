import { Inject, Injectable } from '@nestjs/common';
import { APP_ENVIRONMENT } from '../../config/config.constants';
import type { Environment } from '../../config/environment';
import { CACHE_MANAGER } from '../../infrastructure/cache/cache.constants';
import { CACHE_TTL_SECONDS } from '../../infrastructure/cache/cache-ttl';
import type { DomainCachePort } from '../../infrastructure/cache/domain-cache.port';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/**
 * Featured tokens: the top 3 pools by 24h volume from the `leaderboard_daily`
 * materialized view (refreshed by the indexer/worker every 30s). Empty when the
 * indexer is stale (featured must always be live data).
 */

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

  async find(chainId: number): Promise<FeaturedRow[]> {
    const key = `tokens:featured:${chainId}`;
    const cached = await this.cache.get<FeaturedRow[]>(key);
    if (cached) return cached;

    const watermark = await this.prisma.chainWatermark.findUnique({ where: { chainId } });
    if (!watermark || Date.now() - watermark.blockTime.getTime() > this.staleAfterMs) {
      return [];
    }
    const rows = await this.prisma.$queryRawUnsafe<FeaturedRow[]>(
      `SELECT "pool_id", token, creator, status, name, symbol,
              "daily_volume_eth"::text AS "daily_volume_eth",
              "total_volume_eth"::text AS "total_volume_eth"
       FROM leaderboard_daily WHERE "chain_id" = ${chainId}
       ORDER BY "daily_volume_eth" DESC LIMIT 3`,
    );
    await this.cache.set(key, rows, { ttlSeconds: CACHE_TTL_SECONDS.featured });
    return rows;
  }
}

export type FeaturedRow = {
  pool_id: string;
  token: string;
  creator: string;
  status: string;
  name: string;
  symbol: string;
  daily_volume_eth: string;
  total_volume_eth: string;
};
