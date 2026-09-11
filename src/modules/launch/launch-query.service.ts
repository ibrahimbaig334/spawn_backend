import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { DomainException } from '../../common/http/domain.exception';
import { pageMeta } from '../../common/pagination/page-result';

/**
 * Launch record queries: status tracking for the prepare/relay flow. Records link
 * to onchain state via configHash once the indexer observes the Launched event.
 */

@Injectable()
export class LaunchQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async record(launchId: string): Promise<LaunchRecordPresenter> {
    const record = await this.prisma.launchRecord.findUnique({ where: { id: launchId } });
    if (!record)
      throw new NotFoundException({
        code: 'LAUNCH_RECORD_NOT_FOUND',
        message: `launch ${launchId} not found`,
      });

    // Once a token projection exists for this config, attach it (CONFIRMED).
    let onchain: {
      tokenId: string;
      contractAddress: string;
      poolId: string;
      phase: string;
    } | null = null;
    const token = await this.prisma.token.findFirst({
      where: { chainId: record.chainId, configHash: record.configHash },
      include: { projection: true },
    });
    if (token?.projection) {
      onchain = {
        tokenId: token.id,
        contractAddress: token.projection.contractAddress,
        poolId: token.projection.poolId,
        phase: token.projection.phase,
      };
    }

    return {
      ...present(record),
      onchain,
    };
  }

  async records(query: {
    creator?: string;
    state?: string;
    chainId?: number;
    page?: number;
    limit?: number;
  }): Promise<{
    data: LaunchRecordPresenter[];
    meta: ReturnType<typeof pageMeta>;
  }> {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const where = {
      chainId: query.chainId ?? Number(process.env.DEFAULT_CHAIN_ID ?? 8453),
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
      }),
    ]);
    return {
      data: rows.map((row) => ({ ...present(row), onchain: null })),
      meta: pageMeta(page, limit, total),
    };
  }
}

type LaunchRecordRow = {
  id: string;
  chainId: number;
  creatorWallet: string;
  name: string;
  symbol: string;
  totalSupply: bigint | import('@prisma/client').Prisma.Decimal;
  devBuyShareWad: import('@prisma/client').Prisma.Decimal;
  payoutPlan: bigint | import('@prisma/client').Prisma.Decimal;
  deadline: bigint;
  configHash: string;
  predictedToken: string;
  digest: string;
  mode: string;
  state: string;
  transactionHash: string | null;
  blockNumber: bigint | null;
  failureReason: string | null;
  tokenId: string | null;
  createdAt: Date;
};

export type LaunchRecordPresenter = ReturnType<typeof present> & {
  onchain: { tokenId: string; contractAddress: string; poolId: string; phase: string } | null;
};

function present(record: LaunchRecordRow) {
  return {
    launchId: record.id,
    chainId: record.chainId,
    creatorWallet: record.creatorWallet,
    name: record.name,
    symbol: record.symbol,
    totalSupply: decimalString(record.totalSupply),
    devBuyShareWad: record.devBuyShareWad.toFixed(),
    payoutPlan: decimalString(record.payoutPlan),
    deadline: decimalString(record.deadline),
    configHash: record.configHash,
    predictedToken: record.predictedToken,
    digest: record.digest,
    mode: record.mode,
    state: record.state,
    transactionHash: record.transactionHash,
    blockNumber: record.blockNumber !== null ? decimalString(record.blockNumber) : null,
    failureReason: record.failureReason,
    createdAt: record.createdAt.toISOString(),
  };
}

function decimalString(value: bigint | import('@prisma/client').Prisma.Decimal): string {
  if (typeof value === 'bigint') return value.toString();
  return value.toFixed();
}

export { DomainException };
