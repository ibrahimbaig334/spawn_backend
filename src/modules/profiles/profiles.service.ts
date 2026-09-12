import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService } from '../../infrastructure/database/prisma.service';
import { CACHE_MANAGER } from '../../infrastructure/cache/cache.constants';
import { CACHE_TTL_SECONDS } from '../../infrastructure/cache/cache-ttl';
import type { DomainCachePort } from '../../infrastructure/cache/domain-cache.port';
import { DomainException } from '../../common/http/domain.exception';
import { isAddress } from 'viem';
import { pageMeta, type PageResult } from '../../common/pagination/page-result';

/**
 * Profiles: self-declared wallet identity (username/bio), the user's created
 * launches, and the revenue streams (RevenueNFTs) they currently hold.
 */

function normalizeWallet(wallet: string): string {
  const normalized = wallet.toLowerCase();
  if (!isAddress(normalized, { strict: true }) || /^0x0+$/.test(normalized)) {
    throw new DomainException(
      400,
      'INVALID_WALLET_ADDRESS',
      'walletAddress must be a non-zero EVM address',
    );
  }
  return normalized;
}

@Injectable()
export class ProfilesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: DomainCachePort,
  ) {}

  async find(walletAddress: string): Promise<Record<string, unknown>> {
    const wallet = normalizeWallet(walletAddress);
    const key = `profiles:${wallet}`;
    const cached = await this.cache.get<Record<string, unknown>>(key);
    if (cached) return cached;
    const profile = await this.prisma.profile.findUnique({ where: { walletAddress: wallet } });
    if (!profile) {
      throw new NotFoundException({ code: 'PROFILE_NOT_FOUND', message: 'profile not found' });
    }
    const presenter = {
      walletAddress: profile.walletAddress,
      username: profile.username,
      bio: profile.bio,
      imageUri: profile.imageUri,
      createdAt: profile.createdAt,
    };
    await this.cache.set(key, presenter, { ttlSeconds: CACHE_TTL_SECONDS.profile });
    return presenter;
  }

  async update(
    walletAddress: string,
    input: { username?: string | null; bio?: string | null; imageUri?: string | null },
  ): Promise<Record<string, unknown>> {
    const wallet = normalizeWallet(walletAddress);
    const data: Prisma.ProfileUncheckedUpdateInput = {};
    if (input.username !== undefined) {
      data.username = input.username;
      data.usernameFolded = input.username ? input.username.toLowerCase() : null;
    }
    if (input.bio !== undefined) data.bio = input.bio === null ? null : input.bio;
    if (input.imageUri !== undefined) data.imageUri = input.imageUri;

    try {
      const profile = await this.prisma.profile.upsert({
        where: { walletAddress: wallet },
        create: {
          walletAddress: wallet,
          username: (data.username as string) ?? null,
          usernameFolded: (data.usernameFolded as string) ?? null,
          bio: (data.bio as string) ?? null,
          imageUri: (data.imageUri as string) ?? null,
        },
        update: data,
      });
      await this.cache.delete(`profiles:${wallet}`);
      return {
        walletAddress: profile.walletAddress,
        username: profile.username,
        bio: profile.bio,
        imageUri: profile.imageUri,
        createdAt: profile.createdAt,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DomainException(409, 'USERNAME_TAKEN', 'username already in use');
      }
      throw error;
    }
  }

  /** Created launches: pools where the wallet is the declared creator. */
  async tokens(
    walletAddress: string,
    query: { chainId?: number; sort?: string; page?: number; limit?: number },
  ): Promise<PageResult<unknown>> {
    const wallet = normalizeWallet(walletAddress);
    const chainId = query.chainId ?? Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const where: Prisma.PoolWhereInput = {
      chainId,
      OR: [
        { creator: wallet },
        { tokenRecord: { claimedCreatorWallet: wallet } },
        { tokenRecord: { launchRecord: { creatorWallet: wallet } } },
      ],
    };
    const [total, rows] = await Promise.all([
      this.prisma.pool.count({ where }),
      this.prisma.pool.findMany({
        where,
        orderBy: { launchTime: query.sort === 'oldest' ? 'asc' : 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { tokenRecord: true, stats: true },
      }),
    ]);
    return {
      data: rows.map((p) => ({
        poolId: p.poolId,
        token: p.token,
        name: p.tokenRecord?.name ?? null,
        symbol: p.tokenRecord?.symbol ?? null,
        status: p.status,
        launchTime: p.launchTime,
        imageUri: p.tokenRecord?.imageUri ?? null,
      })),
      meta: pageMeta(page, limit, total),
    };
  }

  /** Revenue streams held (RevenueNFT ownership trail lives on-chain; mirrors indexed pools). */
  async revenueStreams(walletAddress: string, query: { chainId?: number }): Promise<unknown[]> {
    const wallet = normalizeWallet(walletAddress);
    const chainId = query.chainId ?? Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
    const rows = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT p."pool_id", p.status, p.token, t.name, t.symbol,
              COALESCE(s."creator_revenue_total", 0)::text AS "creator_revenue_total",
              COALESCE(s."creator_path_revenue_total", 0)::text AS "creator_path_revenue_total",
              p."launch_time"
       FROM pools p
       JOIN tokens t ON t."chain_id" = p."chain_id" AND t.token = p.token
       LEFT JOIN pool_stats s ON s."chain_id" = p."chain_id" AND s."pool_id" = p."pool_id"
       WHERE p."chain_id" = ${chainId} AND p."revenue_nft_owner" = '${wallet}'
       ORDER BY p."launch_time" DESC`,
    );
    return rows;
  }
}
