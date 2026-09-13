import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService } from '../../infrastructure/database/prisma.service';
import { CACHE_MANAGER } from '../../infrastructure/cache/cache.constants';
import { CACHE_TTL_SECONDS } from '../../infrastructure/cache/cache-ttl';
import type { DomainCachePort } from '../../infrastructure/cache/domain-cache.port';
import { APP_ENVIRONMENT } from '../../config/config.constants';
import type { Environment } from '../../config/environment';
import { DomainException } from '../../common/http/domain.exception';
import { pageMeta, type PageResult } from '../../common/pagination/page-result';
import { bandLevels } from '../../protocol/protocol-math';
import { PROTOCOL_TEMPLATE_DEFAULT as T } from '../../protocol/protocol-constants';
import { sqrtToEthString } from '../trading/price';

/** pg numeric/bigint columns arrive as strings; tolerate number/unknown shapes. */
function s(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return v.toString();
  // Prisma raw queries decode NUMERIC as Decimal instances (objects with
  // toFixed); Decimal.toFixed() always renders plain (never exponential).
  if (v !== null && typeof v === 'object' && typeof (v as { toFixed?: unknown }).toFixed === 'function') {
    return (v as { toFixed(): string }).toFixed();
  }
  return '0';
}

function bigS(v: unknown): bigint {
  const str = s(v);
  // Tolerate scientific notation defensively (should not occur after s()).
  if (/^\d+$/.test(str)) return BigInt(str);
  const n = Number(str);
  return Number.isFinite(n) ? BigInt(Math.trunc(n)) : 0n;
}

/**
 * Token read service over the data-layer tables (pool_metrics view, pools, swaps,
 * bands + skip facts, revenue fact tables, candles). Amounts are raw units;
 * ETH-per-token conversions happen at the API edge (guide §1 inversion).
 */

type ListQuery = {
  chainId: number;
  q?: string;
  creator?: string;
  phase?: 'bonding' | 'graduated';
  sort: string;
  page: number;
  limit: number;
  skip: number;
};

type DetailQuery = {
  chainId: number;
  tradePage: number;
  tradeLimit: number;
};

type TradeQuery = {
  chainId: number;
  side?: 'BUY' | 'SELL';
  sort: 'newest' | 'oldest' | 'amount';
  page: number;
  limit: number;
  skip: number;
};

type CandleQuery = {
  chainId: number;
  interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
  from?: string;
  to?: string;
  limit: number;
};

type MilestoneQuery = {
  chainId: number;
  page: number;
  limit: number;
  skip: number;
};

type RevenueQuery = {
  chainId: number;
  kind?: string;
  page: number;
  limit: number;
  skip: number;
};

const REVENUE_TABLES: Record<string, string> = {
  creatorAccruals: 'creator_accruals',
  protocolAccruals: 'protocol_accruals',
  creatorPathAccruals: 'creator_path_accruals',
  claims: 'claims',
  payoutTips: 'payout_tips',
  pluginPayouts: 'plugin_payouts',
  potFundings: 'payout_pot_fundings',
  potRedemptions: 'payout_pot_redemptions',
  feeCollections: 'fee_collections',
  feeRoutings: 'fee_routings',
  tokenBurns: 'token_burns',
  graduates: 'graduations',
};

@Injectable()
export class TokenQueryService {
  private readonly staleAfterMs: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: DomainCachePort,
    @Inject(APP_ENVIRONMENT) environment: Environment,
  ) {
    this.staleAfterMs = environment.CHAIN_STALE_AFTER_SECONDS * 1_000;
  }

  private async watermark(chainId: number) {
    return this.prisma.chainWatermark.findUnique({ where: { chainId } });
  }

  async list(query: ListQuery): Promise<PageResult<unknown>> {
    const key = `tokens:list:${JSON.stringify(query)}`;
    const cached = await this.cache.get<PageResult<unknown>>(key);
    if (cached) return cached;

    const where: string[] = [`"chain_id" = ${query.chainId}`];
    if (query.phase) where.push(`status = '${query.phase}'`);
    if (query.creator) where.push(`creator = '${query.creator.toLowerCase()}'`);
    if (query.q) {
      const q = query.q.replace(/'/g, "''");
      where.push(`(name ILIKE '%${q}%' OR symbol ILIKE '%${q}%')`);
    }
    const order =
      query.sort === 'oldest'
        ? '"launch_time" ASC'
        : query.sort === 'graduated'
          ? `CASE status WHEN 'graduated' THEN 0 ELSE 1 END ASC, "launch_time" DESC`
          : query.sort === 'market_cap'
            ? 'mcap_wei DESC NULLS LAST'
            : query.sort === 'volume'
              ? '(COALESCE("buy_volume_eth",0) + COALESCE("sell_volume_eth",0)) DESC NULLS LAST'
              : '"launch_time" DESC';

    const countRows = await this.prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT count(*)::int AS c FROM pool_metrics WHERE ${where.join(' AND ')}`,
    );
    const pageRows = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM pool_metrics WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${query.limit} OFFSET ${query.skip}`,
    );

    const images = await this.imageMap(
      query.chainId,
      pageRows.map((r) => String(r.token ?? '').toLowerCase()).filter(Boolean),
    );
    const result: PageResult<unknown> = {
      data: pageRows.map((r) =>
        cardFromMetrics(r, images.get(String(r.token ?? '').toLowerCase()) ?? null),
      ),
      meta: pageMeta(query.page, query.limit, countRows[0]?.c ?? 0),
    };
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.tokenList });
    return result;
  }

  async detail(tokenRef: string, query: DetailQuery): Promise<Record<string, unknown>> {
    const key = `tokens:detail:${tokenRef.toLowerCase()}:${query.tradePage}:${query.tradeLimit}`;
    const cached = await this.cache.get<Record<string, unknown>>(key);
    if (cached) return this.withFreshness(cached, query.chainId);

    const pool = await this.findPool(tokenRef, query.chainId);
    // Direct on-chain launches have no offchain token row: fall back to the
    // sink's on-chain token record so name/symbol/uri always resolve.
    const chainToken = pool.tokenRecord ?? (await this.sinkToken(pool.token));
    // Logos live on the launch record for relayed/direct launches; surface
    // them here (and backfill the provisioned token row) so cards and detail
    // always render the creator's logo.
    let imageUri = pool.tokenRecord?.imageUri ?? null;
    if (!imageUri) {
      const images = await this.imageMap(query.chainId, [pool.token.toLowerCase()]);
      imageUri = images.get(pool.token.toLowerCase()) ?? null;
      if (imageUri && pool.tokenRecord && !pool.tokenRecord.imageUri) {
        await this.prisma.token
          .update({ where: { id: pool.tokenRecord.id }, data: { imageUri } })
          .catch(() => undefined);
      }
    }
    const stats = await this.prisma.poolStats.findUnique({
      where: { chainId_poolId: { chainId: query.chainId, poolId: pool.poolId } },
    });
    const pot = await this.prisma.pot.findUnique({
      where: { chainId_poolId: { chainId: query.chainId, poolId: pool.poolId } },
    });
    const bandCounts = await this.prisma.band.groupBy({
      by: ['status'],
      where: { chainId: query.chainId, poolId: pool.poolId },
      _count: true,
    });
    const trades = await this.trades(pool.poolId, {
      chainId: query.chainId,
      sort: 'newest',
      page: query.tradePage,
      limit: query.tradeLimit,
      skip: (query.tradePage - 1) * query.tradeLimit,
    });

    const result = {
      poolId: pool.poolId,
      chainId: pool.chainId,
      status: pool.status,
      token: pool.token,
      creator: pool.creator,
      name: pool.tokenRecord?.name ?? chainToken?.name ?? null,
      symbol: pool.tokenRecord?.symbol ?? chainToken?.symbol ?? null,
      description: pool.tokenRecord?.description ?? null,
      imageUri,
      uri: pool.tokenRecord?.uri ?? chainToken?.uri ?? null,
      socials: pool.tokenRecord?.socials ?? null,
      launchTime: pool.launchTime,
      totalSupply: pool.totalSupply.toFixed(),
      circulatingSupply: pool.totalSupply
        .sub(stats?.burnedTotal ?? new Prisma.Decimal(0))
        .toFixed(),
      configHash: pool.configHash,
      payoutPlan: pool.payoutPlan.toFixed(),
      devBuyShareWad: pool.devBuyShareWad.toFixed(),
      openingLevel: pool.openingLevel,
      farLevel: pool.farLevel,
      graduationLevel: pool.graduationLevel,
      wallLiquidity: pool.wallLiquidity?.toFixed() ?? null,
      revenueNftOwner: pool.revenueNftOwner,
      priceEth: stats ? sqrtToEthString(BigInt(stats.lastPriceSqrtX96.toFixed())) : null,
      launchRecord: pool.tokenDbId
        ? await this.prisma.launchRecord.findUnique({
            where: { tokenDbId: pool.tokenDbId },
            select: { id: true, state: true, transactionHash: true },
          })
        : null,
      stats: stats
        ? {
            buyVolumeEth: stats.buyVolumeEth.toFixed(),
            sellVolumeEth: stats.sellVolumeEth.toFixed(),
            buyVolumeTokens: stats.buyVolumeTokens.toFixed(),
            sellVolumeTokens: stats.sellVolumeTokens.toFixed(),
            swapCount: stats.swapCount.toString(),
            lastPriceSqrtX96: stats.lastPriceSqrtX96.toFixed(),
            athSqrtX96: stats.athSqrtX96.toFixed(),
            creatorRevenueTotal: stats.creatorRevenueTotal.toFixed(),
            creatorRevenueCurve: stats.creatorRevenueCurve.toFixed(),
            creatorRevenueSwapFees: stats.creatorRevenueSwapFees.toFixed(),
            protocolRevenueTotal: stats.protocolRevenueTotal.toFixed(),
            protocolRevenueCurve: stats.protocolRevenueCurve.toFixed(),
            protocolRevenueSwapFees: stats.protocolRevenueSwapFees.toFixed(),
            protocolRevenueHarvest: stats.protocolRevenueHarvest.toFixed(),
            creatorPathRevenueTotal: stats.creatorPathRevenueTotal.toFixed(),
            pluginRevenueTotal: stats.pluginRevenueTotal.toFixed(),
            potFundedTotal: stats.potFundedTotal.toFixed(),
            tipsTotal: stats.tipsTotal.toFixed(),
            bandsDeployed: stats.bandsDeployed,
            harvestCount: stats.harvestCount,
            harvestQuoteTotal: stats.harvestQuoteTotal.toFixed(),
            swapFeeBurnedTokens: stats.swapFeeBurnedTokens.toFixed(),
            burnedTotal: stats.burnedTotal.toFixed(),
            lastSwapBlock: stats.lastSwapBlock.toString(),
          }
        : null,
      pot: pot
        ? {
            balance: pot.balance.toFixed(),
            fundedTotal: pot.fundedTotal.toFixed(),
            serviceFeeTotal: pot.serviceFeeTotal.toFixed(),
          }
        : { balance: '0', fundedTotal: '0', serviceFeeTotal: '0' },
      milestones: {
        live: bandCounts.find((b) => b.status === 'live')?._count ?? 0,
        completed: bandCounts.find((b) => b.status === 'completed')?._count ?? 0,
      },
      trades,
    };
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.tokenDetail });
    return this.withFreshness(result, query.chainId);
  }

  async trades(tokenRef: string, query: TradeQuery): Promise<PageResult<unknown>> {
    const key = `tokens:trades:${tokenRef.toLowerCase()}:${JSON.stringify(query)}`;
    const cached = await this.cache.get<PageResult<unknown>>(key);
    if (cached) return cached;
    const pool = await this.findPool(tokenRef, query.chainId);

    const where: Prisma.SwapFactWhereInput = {
      chainId: query.chainId,
      poolId: pool.poolId,
      ...(query.side ? { isBuy: query.side === 'BUY' } : {}),
    };
    const orderBy: Prisma.SwapFactOrderByWithRelationInput[] =
      query.sort === 'amount'
        ? [{ amount0Eth: 'desc' }]
        : query.sort === 'oldest'
          ? [{ blockNumber: 'asc' }, { logIndex: 'asc' }]
          : [{ blockNumber: 'desc' }, { logIndex: 'desc' }];

    const [total, rows] = await Promise.all([
      this.prisma.swapFact.count({ where }),
      this.prisma.swapFact.findMany({ where, orderBy, skip: query.skip, take: query.limit }),
    ]);
    const data = rows.map((r) => ({
      transactionHash: r.transactionHash,
      logIndex: r.logIndex,
      blockNumber: r.blockNumber.toString(),
      timestamp: r.timestamp,
      side: r.isBuy ? 'BUY' : 'SELL',
      sender: r.sender,
      ethAmount: r.amount0Eth.toFixed(),
      tokenAmount: r.amount1Tokens.toFixed(),
      sqrtPriceX96: r.sqrtPriceX96.toFixed(),
      level: -r.tick,
      priceEth: sqrtToEthString(r.sqrtPriceX96 ? BigInt(r.sqrtPriceX96.toFixed()) : 0n),
      feePips: r.fee,
      feeEth: r.feeEth.toFixed(),
      feeTokens: r.feeTokens.toFixed(),
    }));
    const result = { data, meta: pageMeta(query.page, query.limit, total) };
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.trades });
    return result;
  }

  async candles(tokenRef: string, query: CandleQuery): Promise<Record<string, unknown>> {
    if (query.from && query.to && new Date(query.from) >= new Date(query.to)) {
      throw new DomainException(400, 'INVALID_CANDLE_RANGE', 'from must be before to');
    }
    const pool = await this.findPool(tokenRef, query.chainId);
    const timeBounded: string[] = [];
    if (query.from) timeBounded.push(`AND t >= '${new Date(query.from).toISOString()}'`);
    if (query.to) timeBounded.push(`AND t < '${new Date(query.to).toISOString()}'`);

    const direct: Record<string, { table: string; col: string }> = {
      '1m': { table: 'pool_minute_stats', col: 'minute' },
      '1h': { table: 'pool_hour_stats', col: 'hour' },
      '1d': { table: 'pool_day_stats', col: 'day' },
    };
    const views: Record<string, string> = {
      '5m': 'candles_5m',
      '15m': 'candles_15m',
      '4h': 'candles_4h',
    };

    let rows: Record<string, unknown>[];
    const hit = direct[query.interval];
    if (hit) {
      const { table, col } = hit;
      rows = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT *, "${col}" AS t FROM ${table} WHERE "chain_id"=${query.chainId} AND "pool_id"='${pool.poolId}'
         ${timeBounded.join(' ')} ORDER BY "${col}" DESC LIMIT ${query.limit}`,
      );
    } else {
      rows = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT *, bucket AS t FROM ${views[query.interval]} WHERE "chain_id"=${query.chainId} AND "pool_id"='${pool.poolId}'
         ${timeBounded.join(' ')} ORDER BY bucket DESC LIMIT ${query.limit}`,
      );
    }

    return {
      poolId: pool.poolId,
      chainId: query.chainId,
      interval: query.interval,
      candles: rows.reverse().map(candlePresenter),
    };
  }

  async milestones(tokenRef: string, query: MilestoneQuery): Promise<PageResult<unknown>> {
    const pool = await this.findPool(tokenRef, query.chainId);
    if (pool.status !== 'graduated' || pool.graduationLevel === null) {
      return { data: [], meta: pageMeta(query.page, query.limit, 0) };
    }
    const grad = pool.graduationLevel;
    const [deployed, skipped] = await Promise.all([
      this.prisma.band.findMany({
        where: { chainId: query.chainId, poolId: pool.poolId },
        orderBy: { bandIndex: 'asc' },
      }),
      this.prisma.bandSkipFact.findMany({
        where: { chainId: query.chainId, poolId: pool.poolId },
        select: { bandIndex: true },
      }),
    ]);
    const deployedByIndex = new Map(deployed.map((b) => [b.bandIndex, b]));
    const skippedSet = new Set(skipped.map((s) => s.bandIndex));

    const rows: unknown[] = [];
    const upper = T.coreBandCount + T.maxFeeFundedBands;
    for (let i = 0; i < upper; i += 1) {
      const geom = bandLevels(
        grad,
        T.bandFirstStepLevels,
        T.bandStepDecayLevels,
        T.bandLevelSpacing,
        T.bandWidthLevels,
        i,
      );
      if (!geom.exists) break;
      const b = deployedByIndex.get(i);
      const state = b
        ? b.status === 'completed'
          ? 'HARVESTED'
          : 'DEPLOYED'
        : skippedSet.has(i)
          ? 'SKIPPED'
          : 'PENDING';
      rows.push({
        index: i,
        kind: i < T.coreBandCount ? 'CORE' : 'EXTENSION',
        state,
        levelLower: b?.levelLower ?? geom.levelLower,
        levelUpper: b?.levelUpper ?? geom.levelUpper,
        liquidity: b?.liquidity.toFixed() ?? null,
        tokenInventory: b?.tokenInventory.toFixed() ?? null,
        deployedAt: b?.deployedAt ?? null,
        completedAt: b?.completedAt ?? null,
      });
    }
    const page = rows.slice(query.skip, query.skip + query.limit);
    return { data: page, meta: pageMeta(query.page, query.limit, rows.length) };
  }

  async revenue(tokenRef: string, query: RevenueQuery): Promise<PageResult<unknown>> {
    const pool = await this.findPool(tokenRef, query.chainId);
    const kind = query.kind ?? 'creatorAccruals';
    const table = REVENUE_TABLES[kind];
    if (!table) {
      throw new DomainException(
        400,
        'INVALID_REVENUE_KIND',
        `kind must be one of: ${Object.keys(REVENUE_TABLES).join(', ')}`,
      );
    }
    const countRows = await this.prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT count(*)::int AS c FROM ${table} WHERE "chain_id"=${query.chainId} AND "pool_id"='${pool.poolId}'`,
    );
    const rows = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM ${table} WHERE "chain_id"=${query.chainId} AND "pool_id"='${pool.poolId}'
       ORDER BY "block_number" DESC, "log_index" DESC LIMIT ${query.limit} OFFSET ${query.skip}`,
    );
    return { data: rows, meta: pageMeta(query.page, query.limit, countRows[0]?.c ?? 0) };
  }

  private async findPool(tokenRef: string, chainId: number) {
    const norm = tokenRef.toLowerCase();
    const isPoolId = norm.startsWith('0x') && norm.length === 66;
    const pool = isPoolId
      ? await this.prisma.pool.findUnique({
          where: { chainId_poolId: { chainId, poolId: norm } },
          include: { tokenRecord: true },
        })
      : await this.prisma.pool.findFirst({
          where: {
            chainId,
            OR: [{ token: norm }, ...(norm.startsWith('0x') ? [] : [{ tokenDbId: norm }])],
          },
          include: { tokenRecord: true },
        });
    if (!pool)
      throw new NotFoundException({
        code: 'TOKEN_NOT_FOUND',
        message: `no launch for ${tokenRef}`,
      });
    return pool;
  }

  /**
   * Logo map for a page of pools: offchain/API token rows win, otherwise the
   * latest launch record for the token address (relay/direct launches store
   * the pinned logo there). One batched lookup per source per page.
   */
  private async imageMap(chainId: number, tokens: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (tokens.length === 0) return map;
    const list = tokens.map((t) => `'${t}'`).join(',');
    const offchain = await this.prisma.$queryRawUnsafe<{ token: string; image: string }[]>(
      `SELECT LOWER(token) AS token, "imageUri" AS image FROM backend.tokens
       WHERE "chain_id" = ${chainId} AND LOWER(token) IN (${list}) AND "imageUri" IS NOT NULL`,
    );
    for (const row of offchain) {
      if (row.image) map.set(row.token, row.image);
    }
    const missing = tokens.filter((t) => !map.has(t));
    if (missing.length > 0) {
      const missingList = missing.map((t) => `'${t}'`).join(',');
      const records = await this.prisma.$queryRawUnsafe<{ token: string; image: string }[]>(
        `SELECT LOWER("predictedToken") AS token, "imageUri" AS image FROM backend.launch_records
         WHERE "chainId" = ${chainId} AND LOWER("predictedToken") IN (${missingList})
           AND "imageUri" IS NOT NULL
         ORDER BY "createdAt" DESC`,
      );
      for (const row of records) {
        if (row.image && !map.has(row.token)) map.set(row.token, row.image);
      }
    }
    return map;
  }

  private async sinkToken(token: string): Promise<{ name: string; symbol: string; uri: string } | null> {
    const rows = await this.prisma.$queryRawUnsafe<{ name: string; symbol: string; uri: string }[]>(
      `SELECT name, symbol, uri FROM public.tokens WHERE token = '${token.toLowerCase()}'`,
    );
    return rows[0] ?? null;
  }

  private async withFreshness(
    value: Record<string, unknown>,
    chainId: number,
  ): Promise<Record<string, unknown>> {
    const wm = await this.watermark(chainId);
    const fresh = wm && Date.now() - wm.blockTime.getTime() <= this.staleAfterMs;
    return { ...value, stale: !fresh };
  }
}

function cardFromMetrics(r: Record<string, unknown>, imageUri: string | null = null): Record<string, unknown> {
  const lastSqrt = bigS(r.last_price_sqrt_x96);
  return {
    poolId: r.pool_id,
    chainId: r.chain_id,
    status: r.status,
    token: r.token,
    creator: r.creator,
    name: r.name,
    symbol: r.symbol,
    launchTime: r.launch_time,
    totalSupply: s(r.total_supply),
    circulatingSupply: r.circulating_supply === null ? s(r.total_supply) : s(r.circulating_supply),
    priceEth: lastSqrt > 0n ? sqrtToEthString(lastSqrt) : null,
    fdvEthWei: r.fdv_wei === null ? null : s(r.fdv_wei),
    mcapEthWei: r.mcap_wei === null ? null : s(r.mcap_wei),
    athMcapEthWei: r.ath_mcap_wei === null ? null : s(r.ath_mcap_wei),
    buyVolumeEth: s(r.buy_volume_eth),
    sellVolumeEth: s(r.sell_volume_eth),
    swapCount: s(r.swap_count),
    creatorRevenueTotal: s(r.creator_revenue_total),
    protocolRevenueTotal: s(r.protocol_revenue_total),
    imageUri,
  };
}

function candlePresenter(row: Record<string, unknown>): Record<string, unknown> {
  const open = bigS(row.open_sqrt_x96);
  const close = bigS(row.close_sqrt_x96);
  const highSqrt = bigS(row.high_sqrt_x96);
  const lowSqrt = bigS(row.low_sqrt_x96);
  return {
    time: row.t ?? row.time,
    // ETH per token = 2^192/sqrt^2 is inverted: the highest ETH price is the
    // lowest sqrt price (guide §1). OHLC extremes swap sqrt high<->ETH high.
    openEth: open > 0n ? sqrtToEthString(open) : null,
    closeEth: close > 0n ? sqrtToEthString(close) : null,
    highEth: lowSqrt > 0n ? sqrtToEthString(lowSqrt) : null,
    lowEth: highSqrt > 0n ? sqrtToEthString(highSqrt) : null,
    openSqrtX96: s(row.open_sqrt_x96),
    highSqrtX96: s(row.high_sqrt_x96),
    lowSqrtX96: s(row.low_sqrt_x96),
    closeSqrtX96: s(row.close_sqrt_x96),
    buyVolumeEth: s(row.buy_volume_eth),
    sellVolumeEth: s(row.sell_volume_eth),
    swapCount: s(row.swap_count),
  };
}
