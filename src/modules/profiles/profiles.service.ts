import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { pageMeta, type PageResult } from '../../common/pagination/page-result';
import { CACHE_MANAGER } from '../../infrastructure/cache/cache.constants';
import { CACHE_TTL_SECONDS } from '../../infrastructure/cache/cache-ttl';
import type { DomainCachePort } from '../../infrastructure/cache/domain-cache.port';
import { APP_ENVIRONMENT } from '../../config/config.constants';
import type { Environment } from '../../config/environment';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { PortfolioQueryDto, ProfileTokensQueryDto } from './dto/profile-query.dto';
import { normalizeWalletAddress, type UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class ProfilesService {
  private readonly staleAfterMs: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: DomainCachePort,
    @Inject(APP_ENVIRONMENT) environment: Environment,
  ) {
    this.staleAfterMs = environment.CHAIN_STALE_AFTER_SECONDS * 1_000;
  }

  async find(walletAddress: string): Promise<unknown> {
    const wallet = normalizeWalletAddress(walletAddress);
    const key = `profiles:${wallet}`;
    const cached = await this.cache.get<unknown>(key);
    if (cached) return cached;
    const profile = await this.prisma.profile.findUnique({
      where: { walletAddress: wallet },
    });
    if (!profile) throw new NotFoundException({ code: 'PROFILE_NOT_FOUND' });
    await this.cache.set(key, profile, { ttlSeconds: CACHE_TTL_SECONDS.profile });
    return profile;
  }

  async update(walletAddress: string, input: UpdateProfileDto): Promise<unknown> {
    const wallet = normalizeWalletAddress(walletAddress);
    const data = this.profileData(input);
    try {
      const profile = await this.prisma.profile.upsert({
        where: { walletAddress: wallet },
        create: { walletAddress: wallet, ...data },
        update: data,
      });
      await this.cache.delete(`profiles:${wallet}`);
      return profile;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException({ code: 'USERNAME_TAKEN', message: 'Username is unavailable' });
      }
      throw error;
    }
  }

  async tokens(walletAddress: string, query: ProfileTokensQueryDto): Promise<PageResult<unknown>> {
    const wallet = normalizeWalletAddress(walletAddress);
    const key = this.cacheKey(`profiles:${wallet}:tokens`, query);
    const cached = await this.cache.get<PageResult<unknown>>(key);
    if (cached) return cached;
    await this.requireProfile(wallet);
    const watermark = await this.prisma.chainWatermark.findUnique({
      where: { chainId: query.chainId },
    });
    const where: Prisma.TokenWhereInput = {
      claimedCreatorWallet: wallet,
    };
    const [total, tokens] = await this.prisma.$transaction([
      this.prisma.token.count({ where }),
      this.prisma.token.findMany({
        where,
        include: { projection: true },
        orderBy: [{ createdAt: query.sort === 'oldest' ? 'asc' : 'desc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
    ]);
    const result = {
      data: tokens.map((token) => {
        const projection =
          watermark &&
          token.projection !== null &&
          token.projection.chainId === query.chainId &&
          token.projection.projectionVersion <= watermark.committedVersion
            ? token.projection
            : null;
        return {
          tokenId: token.id,
          name: token.name,
          symbol: token.symbol,
          description: token.description,
          imageUri: token.imageUri,
          ipfsUri: token.ipfsUri,
          gatewayUrl: token.gatewayUrl,
          socials: token.socials,
          onchain:
            projection === null
              ? null
              : {
                  phase: projection.phase,
                  contractAddress: projection.contractAddress,
                  poolId: projection.poolId,
                },
          createdAt: token.createdAt,
        };
      }),
      meta: pageMeta(query.page, query.limit, total),
    };
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.creatorTokens });
    return result;
  }

  async portfolio(
    walletAddress: string,
    query: PortfolioQueryDto,
  ): Promise<Record<string, unknown>> {
    const wallet = normalizeWalletAddress(walletAddress);
    const key = this.cacheKey(`profiles:${wallet}:portfolio`, query);
    const cached = await this.cache.get<Record<string, unknown>>(key);
    if (cached) return this.withPortfolioFreshness(cached);
    await this.requireProfile(wallet);
    const result = await this.prisma.$transaction(
      async (tx) => {
        const watermark = await tx.chainWatermark.findUnique({ where: { chainId: query.chainId } });
        if (!watermark) return this.emptyPortfolio(wallet, query);
        const where: Prisma.HoldingWhereInput = {
          walletAddress: wallet,
          chainId: query.chainId,
          projectionVersion: { lte: watermark.committedVersion },
        };
        const orderBy: Prisma.HoldingOrderByWithRelationInput[] =
          query.sort === 'recent'
            ? [{ lastActivityAt: 'desc' }, { tokenId: 'asc' }]
            : query.sort === 'balance'
              ? [{ balanceRaw: 'desc' }, { tokenId: 'asc' }]
              : [{ valueUsd: { sort: 'desc', nulls: 'last' } }, { tokenId: 'asc' }];
        const [total, holdings, aggregates] = await Promise.all([
          tx.holding.count({ where }),
          tx.holding.findMany({
            where,
            include: {
              token: {
                select: {
                  id: true,
                  name: true,
                  symbol: true,
                  imageUri: true,
                  projection: {
                    select: {
                      decimals: true,
                      contractAddress: true,
                      phase: true,
                      chainId: true,
                      projectionVersion: true,
                    },
                  },
                },
              },
            },
            orderBy,
            skip: query.skip,
            take: query.limit,
          }),
          tx.holding.aggregate({
            where,
            _sum: { valueUsd: true },
            _count: { _all: true, valueUsd: true },
          }),
        ]);
        return {
          walletAddress: wallet,
          chainId: query.chainId,
          data: holdings.map((holding) =>
            this.holdingItem(holding, query.chainId, watermark.committedVersion),
          ),
          aggregatePricedValueUsd: aggregates._sum.valueUsd ?? new Prisma.Decimal(0),
          unpricedCount: aggregates._count._all - aggregates._count.valueUsd,
          meta: pageMeta(query.page, query.limit, total),
          watermark: {
            committedVersion: watermark.committedVersion,
            blockNumber: watermark.blockNumber,
            blockTime: watermark.blockTime,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.portfolio });
    return this.withPortfolioFreshness(result);
  }

  private profileData(
    input: UpdateProfileDto,
  ): Pick<Prisma.ProfileUncheckedCreateInput, 'username' | 'usernameFolded' | 'bio' | 'imageUri'> {
    const data: Pick<
      Prisma.ProfileUncheckedCreateInput,
      'username' | 'usernameFolded' | 'bio' | 'imageUri'
    > = {};
    if ('username' in input) {
      data.username = input.username ?? null;
      data.usernameFolded = input.username?.toLowerCase() ?? null;
    }
    if ('bio' in input) data.bio = input.bio ?? null;
    if ('imageUri' in input) data.imageUri = input.imageUri ?? null;
    return data;
  }

  private async requireProfile(walletAddress: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { walletAddress },
      select: { walletAddress: true },
    });
    if (!profile) throw new NotFoundException({ code: 'PROFILE_NOT_FOUND' });
  }

  private holdingItem(
    holding: {
      tokenId: string;
      balanceRaw: Prisma.Decimal;
      valueUsd: Prisma.Decimal | null;
      lastActivityAt: Date;
      sourceBlockNumber: bigint;
      sourceBlockTime: Date;
      token: {
        id: string;
        name: string;
        symbol: string;
        imageUri: string;
        projection: {
          decimals: number;
          contractAddress: string;
          phase: string;
          chainId: number;
          projectionVersion: bigint;
        } | null;
      };
    },
    chainId: number,
    committedVersion: bigint,
  ): Record<string, unknown> {
    const projection = holding.token.projection;
    const onchain =
      projection !== null &&
      projection.chainId === chainId &&
      projection.projectionVersion <= committedVersion
        ? projection
        : null;
    return {
      tokenId: holding.tokenId,
      name: holding.token.name,
      symbol: holding.token.symbol,
      imageUri: holding.token.imageUri,
      contractAddress: onchain?.contractAddress ?? null,
      phase: onchain?.phase ?? null,
      balanceRaw: holding.balanceRaw,
      balance: onchain ? humanBalance(holding.balanceRaw, onchain.decimals) : null,
      valueUsd: holding.valueUsd,
      lastActivityAt: holding.lastActivityAt,
      sourceBlockNumber: holding.sourceBlockNumber,
      sourceBlockTime: holding.sourceBlockTime,
    };
  }

  private emptyPortfolio(wallet: string, query: PortfolioQueryDto): Record<string, unknown> {
    return {
      walletAddress: wallet,
      chainId: query.chainId,
      data: [],
      aggregatePricedValueUsd: new Prisma.Decimal(0),
      unpricedCount: 0,
      meta: pageMeta(query.page, query.limit, 0),
      watermark: null,
    };
  }

  private withPortfolioFreshness(value: Record<string, unknown>): Record<string, unknown> {
    const watermark = value.watermark;
    if (!watermark || typeof watermark !== 'object' || !('blockTime' in watermark)) {
      return { ...value, stale: true };
    }
    const blockTime = watermark.blockTime;
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
}

function humanBalance(value: Prisma.Decimal, decimals: number): string {
  const digits = value.toFixed(0).padStart(decimals + 1, '0');
  if (decimals === 0) return digits;
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/u, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
