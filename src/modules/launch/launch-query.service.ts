import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService } from '../../infrastructure/database/prisma.service';
import { pageMeta } from '../../common/pagination/page-result';
import { resolveChainId } from '../../common/chain-id';

/**
 * Launch record queries. Records link to onchain state via configHash once the
 * indexer observes the Launched event.
 */

@Injectable()
export class LaunchQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async record(launchId: string): Promise<LaunchRecordPresenter> {
    const record = await this.prisma.launchRecord.findUnique({
      where: { id: launchId },
      include: { token: { include: { pool: { select: { poolId: true, status: true } } } } },
    });
    if (!record) {
      throw new NotFoundException({
        code: 'LAUNCH_RECORD_NOT_FOUND',
        message: `launch ${launchId} not found`,
      });
    }
    return {
      ...present(record),
      onchain: record.token?.pool
        ? {
            token: record.token.token,
            poolId: record.token.pool.poolId,
            status: record.token.pool.status,
          }
        : null,
    };
  }

  async records(query: {
    creator?: string;
    state?: string;
    chainId?: number;
    page?: number;
    limit?: number;
  }): Promise<{ data: LaunchRecordPresenter[]; meta: ReturnType<typeof pageMeta> }> {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const where: Prisma.LaunchRecordWhereInput = {
      chainId: resolveChainId(query.chainId),
      ...(query.creator ? { creatorWallet: query.creator.toLowerCase() } : {}),
      ...(query.state ? { state: query.state as never } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.launchRecord.count({ where }),
      this.prisma.launchRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { token: { include: { pool: { select: { poolId: true, status: true } } } } },
      }),
    ]);
    return {
      data: rows.map((r) => ({
        ...present(r),
        onchain: r.token?.pool
          ? { token: r.token.token, poolId: r.token.pool.poolId, status: r.token.pool.status }
          : null,
      })),
      meta: pageMeta(page, limit, total),
    };
  }
}

type LaunchRecordWithToken = Prisma.LaunchRecordGetPayload<{
  include: { token: { include: { pool: { select: { poolId: true; status: true } } } } };
}>;

export type LaunchRecordPresenter = ReturnType<typeof present> & {
  onchain: { token: string | null; poolId: string; status: string } | null;
};

function present(record: LaunchRecordWithToken) {
  return {
    launchId: record.id,
    chainId: record.chainId,
    creatorWallet: record.creatorWallet,
    name: record.name,
    symbol: record.symbol,
    uri: record.uri,
    totalSupply: record.totalSupply.toFixed(),
    devBuyShareWad: record.devBuyShareWad.toFixed(),
    payoutPlan: record.payoutPlan.toFixed(),
    deadline: record.deadline.toString(),
    configHash: record.configHash,
    predictedToken: record.predictedToken,
    digest: record.digest,
    state: record.state,
    transactionHash: record.transactionHash,
    blockNumber: record.blockNumber !== null ? record.blockNumber.toString() : null,
    failureReason: record.failureReason,
    createdAt: record.createdAt.toISOString(),
  };
}
