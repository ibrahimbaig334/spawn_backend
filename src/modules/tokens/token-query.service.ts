import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  MilestoneKind,
  Prisma,
  Timeframe,
  type TokenChainState,
  type TokenMetric,
} from '@prisma/client';
import { APP_ENVIRONMENT } from '../../config/config.constants';
import type { Environment } from '../../config/environment';
import { CACHE_MANAGER } from '../../infrastructure/cache/cache.constants';
import { CACHE_TTL_SECONDS } from '../../infrastructure/cache/cache-ttl';
import type { DomainCachePort } from '../../infrastructure/cache/domain-cache.port';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { DomainException } from '../../common/http/domain.exception';
import { pageMeta, type PageResult } from '../../common/pagination/page-result';
import type { TokenDetailQueryDto } from './dto/token-detail-query.dto';
import type { TokenListQueryDto } from './dto/token-list-query.dto';
import {
  PRISMA_CANDLE_INTERVALS,
  type TokenCandlesQueryDto,
  type TokenMilestonesQueryDto,
  type TokenRevenueQueryDto,
} from './dto/token-projection-query.dto';
import { timeframeStart, toPrismaTimeframe } from './dto/query-values';
import { tokenPriceEthString } from '../../protocol/protocol-math';

interface TokenListItem {
  tokenId: string;
  name: string;
  symbol: string;
  description: string;
  imageUri: string;
  claimedCreatorWallet: string;
  metadata: Record<string, unknown>;
  onchain: Record<string, unknown> | null;
  metrics: Record<string, unknown> | null;
  createdAt: Date;
}

interface TokenListIdRow {
  id: string;
}

interface TokenListCountRow {
  total: number;
}

interface ProjectionSnapshot {
  chain: TokenChainState | null;
  metric: TokenMetric | null;
  watermark: { committedVersion: bigint; blockNumber: bigint; blockTime: Date } | null;
}

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

  async list(query: TokenListQueryDto): Promise<PageResult<TokenListItem>> {
    if (query.sort === 'relevance' && !query.q?.trim()) {
      throw new DomainException(400, 'RELEVANCE_REQUIRES_QUERY', 'sort=relevance requires q');
    }
    const key = this.cacheKey('tokens:list', query);
    const cached = await this.cache.get<PageResult<TokenListItem>>(key);
    if (cached) return cached;

    const result = await this.prisma.$transaction(
      async (tx) => {
        const watermark = await tx.chainWatermark.findUnique({ where: { chainId: query.chainId } });
        const page = await this.listPage(tx, query, watermark?.committedVersion ?? null);
        if (page.ids.length === 0) {
          return { data: [], meta: pageMeta(query.page, query.limit, page.total) };
        }
        const tokens = await tx.token.findMany({
          where: { id: { in: page.ids } },
          include: {
            projection: {
              where: {
                chainId: query.chainId,
                projectionVersion: { lte: watermark?.committedVersion ?? -1n },
              },
            },
            metrics: {
              where: {
                chainId: query.chainId,
                timeframe: toPrismaTimeframe(query.timeframe),
                projectionVersion: { lte: watermark?.committedVersion ?? -1n },
              },
              take: 1,
            },
          },
        });
        const byId = new Map(tokens.map((token) => [token.id, token]));
        const data = page.ids.flatMap((id) => {
          const token = byId.get(id);
          if (!token) return [];
          return [this.listItem(token, token.projection, token.metrics[0] ?? null)];
        });
        return { data, meta: pageMeta(query.page, query.limit, page.total) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.tokenList });
    return result;
  }

  private async listPage(
    tx: Prisma.TransactionClient,
    query: TokenListQueryDto,
    committedVersion: bigint | null,
  ): Promise<{ ids: string[]; total: number }> {
    const conditions: Prisma.Sql[] = [];
    if (query.creator) conditions.push(Prisma.sql`t."claimedCreatorWallet" = ${query.creator}`);
    if (query.q?.trim()) {
      const q = query.q.trim();
      conditions.push(Prisma.sql`(t.name ILIKE ${`%${q}%`} OR t.symbol ILIKE ${`%${q}%`})`);
    }
    if (query.hasOnchainProjection === true || query.phase !== undefined) {
      if (committedVersion === null) conditions.push(Prisma.sql`FALSE`);
      else conditions.push(Prisma.sql`cs."tokenId" IS NOT NULL`);
    } else if (query.hasOnchainProjection === false) {
      conditions.push(Prisma.sql`cs."tokenId" IS NULL`);
    }
    if (query.phase !== undefined) {
      conditions.push(Prisma.sql`cs.phase = ${query.phase}::"OnchainPhase"`);
    }

    const projectionJoin =
      committedVersion === null
        ? Prisma.sql`LEFT JOIN token_chain_states cs ON FALSE`
        : Prisma.sql`LEFT JOIN token_chain_states cs
            ON cs."tokenId" = t.id
           AND cs."chainId" = ${query.chainId}
           AND cs."projectionVersion" <= ${committedVersion}`;
    const metricJoin =
      committedVersion === null
        ? Prisma.sql`LEFT JOIN token_metrics tm ON FALSE`
        : Prisma.sql`LEFT JOIN token_metrics tm
            ON tm."tokenId" = t.id
           AND tm."chainId" = ${query.chainId}
           AND tm.timeframe = ${toPrismaTimeframe(query.timeframe)}::"Timeframe"
           AND tm."projectionVersion" <= ${committedVersion}`;
    const where =
      conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
    const [countRow] = await tx.$queryRaw<TokenListCountRow[]>(Prisma.sql`
      SELECT COUNT(*)::int AS total
      FROM tokens t
      ${projectionJoin}
      ${where}
    `);
    const rows = await tx.$queryRaw<TokenListIdRow[]>(Prisma.sql`
      SELECT t.id
      FROM tokens t
      ${projectionJoin}
      ${metricJoin}
      ${where}
      ORDER BY ${this.listOrderSql(query)}
      OFFSET ${query.skip}
      LIMIT ${query.limit}
    `);
    return { ids: rows.map((row) => row.id), total: countRow?.total ?? 0 };
  }

  private listOrderSql(query: TokenListQueryDto): Prisma.Sql {
    if (query.sort === 'oldest') return Prisma.sql`t."createdAt" ASC, t.id ASC`;
    if (query.sort === 'newest') return Prisma.sql`t."createdAt" DESC, t.id ASC`;
    if (query.sort === 'market_cap') {
      return Prisma.sql`COALESCE(tm."marketCapUsd", tm."marketCapEth") DESC NULLS LAST, t."createdAt" DESC, t.id ASC`;
    }
    if (query.sort === 'volume') {
      return Prisma.sql`COALESCE(tm."volumeUsd", tm."volumeEth") DESC NULLS LAST, t."createdAt" DESC, t.id ASC`;
    }
    if (query.sort === 'graduated') {
      return Prisma.sql`CASE cs.phase
        WHEN 'GRADUATED'::"OnchainPhase" THEN 0
        WHEN 'BONDING_CURVE'::"OnchainPhase" THEN 1
        WHEN 'NONE'::"OnchainPhase" THEN 2
        ELSE 3
      END ASC, t."createdAt" DESC, t.id ASC`;
    }
    const q = query.q?.trim() ?? '';
    return Prisma.sql`CASE
        WHEN lower(t.symbol) = lower(${q}) THEN 0
        WHEN lower(t.name) = lower(${q}) THEN 1
        WHEN lower(t.symbol) LIKE lower(${`${q}%`}) THEN 2
        WHEN lower(t.name) LIKE lower(${`${q}%`}) THEN 3
        ELSE 4
      END ASC,
      ts_rank_cd(to_tsvector('simple', t.name || ' ' || t.symbol), plainto_tsquery('simple', ${q})) DESC,
      similarity(t.name || ' ' || t.symbol, ${q}) DESC,
      t."createdAt" DESC,
      t.id ASC`;
  }

  private listItem(
    token: {
      id: string;
      name: string;
      symbol: string;
      description: string;
      imageUri: string;
      ipfsUri: string;
      gatewayUrl: string;
      socials: Prisma.JsonValue;
      claimedCreatorWallet: string;
      createdAt: Date;
    },
    chain: TokenChainState | null,
    metric: TokenMetric | null,
  ): TokenListItem {
    return {
      tokenId: token.id,
      name: token.name,
      symbol: token.symbol,
      description: token.description,
      imageUri: token.imageUri,
      claimedCreatorWallet: token.claimedCreatorWallet,
      metadata: {
        ipfsUri: token.ipfsUri,
        gatewayUrl: token.gatewayUrl,
        socials: token.socials,
      },
      onchain: chain ? this.chainPresenter(chain) : null,
      metrics: metric ? this.metricPresenter(metric) : null,
      createdAt: token.createdAt,
    };
  }

  async detail(tokenRef: string, query: TokenDetailQueryDto): Promise<Record<string, unknown>> {
    const key = this.cacheKey(`tokens:detail:${tokenRef.toLowerCase()}`, query);
    const cached = await this.cache.get<Record<string, unknown>>(key);
    if (cached) return this.withFreshness(cached);

    const result = await this.prisma.$transaction(
      async (tx) => {
        const token = await this.resolveToken(tx, tokenRef, query.chainId);
        const snapshot = await this.projectionSnapshot(
          tx,
          token.id,
          query.chainId,
          toPrismaTimeframe(query.timeframe),
        );
        const trades = await this.findTrades(tx, token.id, {
          chainId: query.chainId,
          timeframe: query.timeframe,
          sort: 'newest',
          page: query.tradePage,
          limit: query.tradeLimit,
          skip: (query.tradePage - 1) * query.tradeLimit,
        });
        const milestoneCounts =
          snapshot.chain && snapshot.watermark
            ? await tx.milestone.groupBy({
                by: ['kind', 'state'],
                where: {
                  tokenId: token.id,
                  chainId: query.chainId,
                  projectionVersion: { lte: snapshot.watermark.committedVersion },
                },
                _count: true,
              })
            : [];
        return {
          tokenId: token.id,
          name: token.name,
          symbol: token.symbol,
          description: token.description,
          imageUri: token.imageUri,
          claimedCreatorWallet: token.claimedCreatorWallet,
          creatorProfile: token.creator,
          launchRecord: token.launchRecord
            ? { launchId: token.launchRecord.id, state: token.launchRecord.state }
            : null,
          ipfsUri: token.ipfsUri,
          gatewayUrl: token.gatewayUrl,
          socials: token.socials,
          onchain: snapshot.chain ? this.chainPresenter(snapshot.chain) : null,
          metrics: snapshot.metric ? this.metricPresenter(snapshot.metric) : null,
          milestones: this.milestoneSummary(milestoneCounts),
          trades,
          watermark: snapshot.watermark,
          createdAt: token.createdAt,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.tokenDetail });
    return this.withFreshness(result);
  }

  async trades(
    tokenRef: string,
    query: {
      chainId: number;
      timeframe: '1h' | '24h' | '7d' | '30d' | 'all';
      side?: 'BUY' | 'SELL';
      sort: 'newest' | 'oldest' | 'amount';
      page: number;
      limit: number;
      skip: number;
    },
  ): Promise<PageResult<unknown>> {
    const key = this.cacheKey(`tokens:trades:${tokenRef.toLowerCase()}`, query);
    const cached = await this.cache.get<PageResult<unknown>>(key);
    if (cached) return cached;
    const result = await this.prisma.$transaction(
      async (tx) => {
        const token = await this.resolveToken(tx, tokenRef, query.chainId);
        return this.findTrades(tx, token.id, query);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.trades });
    return result;
  }

  async candles(tokenRef: string, query: TokenCandlesQueryDto): Promise<Record<string, unknown>> {
    if (query.from && query.to && new Date(query.from) >= new Date(query.to)) {
      throw new DomainException(400, 'INVALID_CANDLE_RANGE', 'from must be before to');
    }
    const key = this.cacheKey(`tokens:candles:${tokenRef.toLowerCase()}`, query);
    const cached = await this.cache.get<Record<string, unknown>>(key);
    if (cached) return cached;
    const result = await this.prisma.$transaction(
      async (tx) => {
        const token = await this.resolveToken(tx, tokenRef, query.chainId);
        const watermark = await tx.chainWatermark.findUnique({ where: { chainId: query.chainId } });
        const bucketStart: Prisma.DateTimeFilter = {};
        if (query.from) bucketStart.gte = new Date(query.from);
        if (query.to) bucketStart.lte = new Date(query.to);
        const rows = watermark
          ? await tx.candle.findMany({
              where: {
                tokenId: token.id,
                chainId: query.chainId,
                interval: PRISMA_CANDLE_INTERVALS[query.interval],
                ...(Object.keys(bucketStart).length > 0 ? { bucketStart } : {}),
                projectionVersion: { lte: watermark.committedVersion },
              },
              orderBy: { bucketStart: 'desc' },
              take: query.limit,
            })
          : [];
        return {
          tokenId: token.id,
          chainId: query.chainId,
          interval: query.interval,
          candles: rows.reverse(),
          watermark,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.candles });
    return result;
  }

  async milestones(tokenRef: string, query: TokenMilestonesQueryDto): Promise<PageResult<unknown>> {
    const key = this.cacheKey(`tokens:milestones:${tokenRef.toLowerCase()}`, query);
    const cached = await this.cache.get<PageResult<unknown>>(key);
    if (cached) return cached;
    const result = await this.prisma.$transaction(
      async (tx) => {
        const token = await this.resolveToken(tx, tokenRef, query.chainId);
        const watermark = await tx.chainWatermark.findUnique({ where: { chainId: query.chainId } });
        if (!watermark) {
          return { data: [], meta: pageMeta(query.page, query.limit, 0) };
        }
        const where: Prisma.MilestoneWhereInput = {
          tokenId: token.id,
          chainId: query.chainId,
          ...(query.kind ? { kind: query.kind } : {}),
          ...(query.state ? { state: query.state } : {}),
          projectionVersion: { lte: watermark.committedVersion },
        };
        const [total, data] = await Promise.all([
          tx.milestone.count({ where }),
          tx.milestone.findMany({
            where,
            orderBy: [{ kind: 'asc' }, { index: 'asc' }],
            skip: query.skip,
            take: query.limit,
          }),
        ]);
        return { data, meta: pageMeta(query.page, query.limit, total) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.milestones });
    return result;
  }

  async revenue(tokenRef: string, query: TokenRevenueQueryDto): Promise<PageResult<unknown>> {
    const key = this.cacheKey(`tokens:revenue:${tokenRef.toLowerCase()}`, query);
    const cached = await this.cache.get<PageResult<unknown>>(key);
    if (cached) return cached;
    const result = await this.prisma.$transaction(
      async (tx) => {
        const token = await this.resolveToken(tx, tokenRef, query.chainId);
        const watermark = await tx.chainWatermark.findUnique({ where: { chainId: query.chainId } });
        if (!watermark) return { data: [], meta: pageMeta(query.page, query.limit, 0) };
        const where: Prisma.RevenueEventWhereInput = {
          tokenId: token.id,
          chainId: query.chainId,
          ...(query.kind ? { kind: query.kind } : {}),
          ...(query.from ? { blockTime: { gte: new Date(query.from) } } : {}),
        };
        const [total, data] = await Promise.all([
          tx.revenueEvent.count({ where }),
          tx.revenueEvent.findMany({
            where,
            orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
            skip: query.skip,
            take: query.limit,
          }),
        ]);
        return { data, meta: pageMeta(query.page, query.limit, total) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.trades });
    return result;
  }

  private async findTrades(
    tx: Prisma.TransactionClient,
    tokenId: string,
    query: {
      chainId: number;
      timeframe: '1h' | '24h' | '7d' | '30d' | 'all';
      side?: 'BUY' | 'SELL';
      sort: 'newest' | 'oldest' | 'amount';
      page: number;
      limit: number;
      skip: number;
    },
  ): Promise<PageResult<unknown>> {
    const watermark = await tx.chainWatermark.findUnique({ where: { chainId: query.chainId } });
    if (!watermark) return { data: [], meta: pageMeta(query.page, query.limit, 0) };
    const start = timeframeStart(query.timeframe);
    const where: Prisma.TradeWhereInput = {
      tokenId,
      chainId: query.chainId,
      ...(query.side ? { side: query.side } : {}),
      ...(start ? { blockTime: { gte: start } } : {}),
      projectionVersion: { lte: watermark.committedVersion },
    };
    const orderBy: Prisma.TradeOrderByWithRelationInput[] =
      query.sort === 'amount'
        ? [
            { tokenAmountRaw: 'desc' },
            { blockNumber: 'desc' },
            { transactionIndex: 'desc' },
            { logIndex: 'desc' },
          ]
        : [
            { blockNumber: query.sort === 'oldest' ? 'asc' : 'desc' },
            { transactionIndex: query.sort === 'oldest' ? 'asc' : 'desc' },
            { logIndex: query.sort === 'oldest' ? 'asc' : 'desc' },
          ];
    const [total, data] = await Promise.all([
      tx.trade.count({ where }),
      tx.trade.findMany({ where, orderBy, skip: query.skip, take: query.limit }),
    ]);
    return { data, meta: pageMeta(query.page, query.limit, total) };
  }

  private async resolveToken(
    tx: Prisma.TransactionClient,
    tokenRef: string,
    chainId: number,
  ): Promise<
    Prisma.TokenGetPayload<{
      include: {
        creator: true;
        launchRecord: true;
      };
    }>
  > {
    const normalized = tokenRef.toLowerCase();
    const uuidReference = this.isUuid(normalized);
    const watermark = uuidReference
      ? null
      : await tx.chainWatermark.findUnique({ where: { chainId } });
    const committedVersion = watermark?.committedVersion;
    if (!uuidReference && committedVersion === undefined) {
      throw new NotFoundException({ code: 'TOKEN_NOT_FOUND' });
    }
    const token = await tx.token.findFirst({
      where: uuidReference
        ? { id: normalized, chainId }
        : {
            chainId,
            projection: {
              chainId,
              contractAddress: normalized,
              projectionVersion: { lte: committedVersion },
            },
          },
      include: {
        creator: true,
        launchRecord: true,
      },
    });
    if (!token) throw new NotFoundException({ code: 'TOKEN_NOT_FOUND' });
    return token;
  }

  private async projectionSnapshot(
    tx: Prisma.TransactionClient,
    tokenId: string,
    chainId: number,
    timeframe: Timeframe,
  ): Promise<ProjectionSnapshot> {
    const watermark = await tx.chainWatermark.findUnique({ where: { chainId } });
    if (!watermark) return { chain: null, metric: null, watermark: null };
    const [chain, metric] = await Promise.all([
      tx.tokenChainState.findFirst({
        where: {
          tokenId,
          chainId,
          projectionVersion: { lte: watermark.committedVersion },
        },
      }),
      tx.tokenMetric.findFirst({
        where: {
          tokenId,
          chainId,
          timeframe,
          projectionVersion: { lte: watermark.committedVersion },
        },
      }),
    ]);
    return {
      chain,
      metric,
      watermark: {
        committedVersion: watermark.committedVersion,
        blockNumber: watermark.blockNumber,
        blockTime: watermark.blockTime,
      },
    };
  }

  private chainPresenter(chain: TokenChainState): Record<string, unknown> {
    const level = chain.lastPriceLevel ?? chain.openingLevel;
    return {
      chainId: chain.chainId,
      phase: chain.phase,
      contractAddress: chain.contractAddress,
      poolId: chain.poolId,
      launchCreatorWallet: chain.launchCreatorWallet,
      creatorRevenueNftId: chain.creatorRevenueNftId,
      creatorRevenueOwner: chain.creatorRevenueOwner,
      totalSupply: chain.totalSupply,
      currentSupply: chain.currentSupply,
      decimals: chain.decimals,
      openingLevel: chain.openingLevel,
      farLevel: chain.farLevel,
      graduationLevel: chain.graduationLevel,
      payoutPlan: chain.payoutPlan,
      devBuyShareWad: chain.devBuyShareWad,
      configHash: chain.configHash,
      allocationsBps: {
        curve: chain.curveSupplyShareBps,
        milestones: chain.ladderSupplyShareBps,
        fullRange: chain.fullRangeSupplyShareBps,
      },
      curvePositions: chain.curvePositions,
      curveDeployed: chain.curveDeployed,
      coreBandCount: chain.coreBandCount,
      completedMilestones: chain.completedMilestones,
      completedExtensionMilestones: chain.completedExtensionMilestones,
      feeFundedBandsCreated: chain.feeFundedBandsCreated,
      payoutPotWei: chain.payoutPot,
      directCreatorClaimableWei: chain.directCreatorClaimable,
      creatorPathClaimableWei: chain.creatorPathClaimable,
      carriedInventoryWei: chain.carriedInventory,
      milestoneFundAccruedWei: chain.milestoneFundAccrued,
      lastPriceLevel: chain.lastPriceLevel,
      priceEthPerToken: tokenPriceEthString(level, chain.decimals),
      launchedAt: chain.launchedAt,
      graduatedAt: chain.graduatedAt,
      projectionVersion: chain.projectionVersion,
      sourceBlockNumber: chain.sourceBlockNumber,
      sourceBlockHash: chain.sourceBlockHash,
      sourceBlockTime: chain.sourceBlockTime,
    };
  }

  private metricPresenter(metric: TokenMetric): Record<string, unknown> {
    return {
      timeframe: metric.timeframe,
      priceEth: metric.priceEth,
      priceUsd: metric.priceUsd,
      marketCapEth: metric.marketCapEth,
      marketCapUsd: metric.marketCapUsd,
      volumeEth: metric.volumeEth,
      volumeUsd: metric.volumeUsd,
      priceChangePct: metric.priceChangePct,
      tradeCount: metric.tradeCount,
      holderCount: metric.holderCount,
      projectionVersion: metric.projectionVersion,
      sourceBlockNumber: metric.sourceBlockNumber,
      sourceBlockTime: metric.sourceBlockTime,
    };
  }

  private milestoneSummary(
    rows: Array<{ kind: MilestoneKind; state: string; _count: number }>,
  ): Record<string, unknown> {
    const total = (kind: MilestoneKind): number =>
      rows.filter((row) => row.kind === kind).reduce((sum, row) => sum + row._count, 0);
    const harvested = (kind: MilestoneKind): number =>
      rows
        .filter((row) => row.kind === kind && row.state === 'HARVESTED')
        .reduce((sum, row) => sum + row._count, 0);
    const deployed = (kind: MilestoneKind): number =>
      rows
        .filter((row) => row.kind === kind && row.state === 'DEPLOYED')
        .reduce((sum, row) => sum + row._count, 0);
    return {
      core: {
        harvested: harvested(MilestoneKind.CORE),
        deployed: deployed(MilestoneKind.CORE),
        total: total(MilestoneKind.CORE),
      },
      extension: {
        harvested: harvested(MilestoneKind.EXTENSION),
        deployed: deployed(MilestoneKind.EXTENSION),
        total: total(MilestoneKind.EXTENSION),
      },
    };
  }

  private withFreshness(value: Record<string, unknown>): Record<string, unknown> {
    const watermark = value.watermark;
    const blockTime =
      watermark && typeof watermark === 'object' && 'blockTime' in watermark
        ? watermark.blockTime
        : undefined;
    const timestamp =
      blockTime instanceof Date ? blockTime.getTime() : Date.parse(String(blockTime));
    return {
      ...value,
      stale: !Number.isFinite(timestamp) || Date.now() - timestamp > this.staleAfterMs,
    };
  }

  private cacheKey(prefix: string, query: object): string {
    const entries = Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `${prefix}:${JSON.stringify(Object.fromEntries(entries))}`;
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  }
}
