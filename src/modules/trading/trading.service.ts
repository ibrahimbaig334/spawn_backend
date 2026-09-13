import { Injectable, NotFoundException } from '@nestjs/common';
import type { Address } from 'viem';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { BlockchainRegistryService } from '../../infrastructure/blockchain/blockchain-registry.service';
import { ProtocolReadService } from '../../infrastructure/blockchain/protocol-read.service';
import { ChainClientFactory } from '../../infrastructure/blockchain/chain-client.factory';
import { V4_QUOTER_ABI } from '../../infrastructure/blockchain/contract-abis';
import { spawnPoolKey } from '../../infrastructure/blockchain/contract-readers';
import {
  curvePositionLiquidity,
  curvePositionStart,
  sqrtPriceAtLevel,
} from '../../protocol/protocol-math';
import {
  PROTOCOL_TEMPLATE_DEFAULT as T,
  FULL_RANGE_TICK_LOWER,
  FULL_RANGE_TICK_UPPER,
  WALL_WIDTH_LEVELS,
} from '../../protocol/protocol-constants';
import { sqrtToEthString, fdvEthWei, levelFromSqrtPrice } from './price';
import { resolveChainId } from '../../common/chain-id';
import type { QuoteQueryDto, DepthQueryDto } from './dto/trading-query.dto';

/**
 * Trading reads: price from the last committed sqrt price (live StateView
 * refresh where available), V4Quoter quotes, and protocol-position depth
 * (curve positions while bonding; bands + full-range + wall once graduated).
 */

@Injectable()
export class TradingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: BlockchainRegistryService,
    private readonly protocolReads: ProtocolReadService,
    private readonly clientFactory: ChainClientFactory,
  ) {}

  private async poolOrThrow(tokenRef: string, chainId: number) {
    const norm = tokenRef.toLowerCase();
    const isPoolId = norm.startsWith('0x') && norm.length === 66;
    const pool = await this.prisma.pool.findUnique({
      where: isPoolId
        ? { chainId_poolId: { chainId, poolId: norm } }
        : { chainId_token: { chainId, token: norm } },
    });
    if (!pool)
      throw new NotFoundException({
        code: 'TOKEN_NOT_FOUND',
        message: `no launch for ${tokenRef}`,
      });
    return pool;
  }

  async price(tokenRef: string, query: { chainId?: number }) {
    const chainId = resolveChainId(query.chainId);
    const pool = await this.poolOrThrow(tokenRef, chainId);
    const stats = await this.prisma.poolStats.findUnique({
      where: { chainId_poolId: { chainId, poolId: pool.poolId } },
    });

    let sqrt = stats?.lastPriceSqrtX96 ? BigInt(stats.lastPriceSqrtX96.toFixed()) : 0n;
    let source: 'indexer' | 'live' | 'opening' = 'indexer';
    try {
      const slot0 = await this.protocolReads.slot0(chainId, pool.poolId);
      if (slot0) {
        sqrt = slot0.sqrtPriceX96;
        source = 'live';
      }
    } catch {
      source = stats ? 'indexer' : 'opening';
    }
    if (sqrt === 0n) {
      sqrt = BigInt(sqrtAtLevel(pool.openingLevel));
      source = 'opening';
    }

    const level = levelFromSqrtPrice(sqrt);
    const totalSupply = BigInt(pool.totalSupply.toFixed());
    const burned = stats ? BigInt(stats.burnedTotal.toFixed()) : 0n;
    const circulating = totalSupply - burned;
    return {
      poolId: pool.poolId,
      chainId,
      token: pool.token,
      status: pool.status,
      level,
      tick: -level,
      sqrtPriceX96: sqrt.toString(),
      priceEth: sqrtToEthString(sqrt),
      fdvEthWei: fdvEthWei(sqrt, totalSupply).toString(),
      mcapEthWei: fdvEthWei(sqrt, circulating).toString(),
      athPriceEth: stats ? sqrtToEthString(BigInt(stats.athSqrtX96.toFixed())) : null,
      openingLevel: pool.openingLevel,
      farLevel: pool.farLevel,
      graduationLevel: pool.graduationLevel,
      progress: curveProgress(pool, level),
      source,
    };
  }

  async quote(tokenRef: string, query: QuoteQueryDto) {
    const chainId = resolveChainId(query.chainId);
    const pool = await this.poolOrThrow(tokenRef, chainId);
    const book = this.registry.book(chainId);
    if (!book.v4Quoter) {
      throw new NotFoundException({
        code: 'QUOTER_NOT_CONFIGURED',
        message: 'V4Quoter address is not configured for this chain',
      });
    }
    const client = this.clientFactory.client(chainId);
    const poolKey = spawnPoolKey(book, pool.token);
    const amount = BigInt(query.amount);
    const zeroForOne = query.side === 'BUY';

    const [amountOut, gasEstimate] = (await client.readContract({
      address: book.v4Quoter as Address,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          poolKey,
          zeroForOne,
          exactAmount: amount,
          hookData: '0x',
        },
      ] as never,
    })) as [bigint, bigint];

    return {
      poolId: pool.poolId,
      chainId,
      side: query.side,
      amountIn: query.amount,
      amountInCurrency: zeroForOne ? 'ETH' : 'TOKEN',
      amountOut: amountOut.toString(),
      amountOutCurrency: zeroForOne ? 'TOKEN' : 'ETH',
      gasEstimate: gasEstimate.toString(),
      note: 'Quote runs the hook beforeSwap simulation (JIT curve/band deploys included). Gas estimates from a quote are not real-swap gas; re-quote on submission errors.',
    };
  }

  async depth(tokenRef: string, query: DepthQueryDto) {
    const chainId = resolveChainId(query.chainId);
    const buckets = Math.min(Math.max(query.buckets ?? 8, 1), 32);
    const pool = await this.poolOrThrow(tokenRef, chainId);
    const stats = await this.prisma.poolStats.findUnique({
      where: { chainId_poolId: { chainId, poolId: pool.poolId } },
    });
    const sqrt = stats?.lastPriceSqrtX96
      ? BigInt(stats.lastPriceSqrtX96.toFixed())
      : BigInt(sqrtAtLevel(pool.openingLevel));
    const level = levelFromSqrtPrice(sqrt);
    const totalSupply = BigInt(pool.totalSupply.toFixed());
    const curveSupply = (totalSupply * 25n) / 100n;

    if (pool.status === 'bonding') {
      const positions = [];
      for (let i = 0; i < T.curvePositions; i += 1) {
        const start = curvePositionStart(pool.openingLevel, pool.farLevel, T.curvePositions, i);
        if (start <= level) continue;
        positions.push({
          position: i,
          startLevel: start,
          endLevel: pool.farLevel,
          liquidity: curvePositionLiquidity(
            pool.openingLevel,
            pool.farLevel,
            T.curvePositions,
            curveSupply,
            i,
          ).toString(),
        });
        if (positions.length >= buckets) break;
      }
      return { poolId: pool.poolId, status: pool.status, level, curvePositions: positions };
    }

    const bands = await this.prisma.band.findMany({
      where: { chainId, poolId: pool.poolId, status: 'live', levelLower: { gt: level } },
      orderBy: { levelLower: 'asc' },
      take: buckets,
    });
    return {
      poolId: pool.poolId,
      status: pool.status,
      level,
      graduationLevel: pool.graduationLevel,
      bands: bands.map((b) => ({
        index: b.bandIndex,
        levelLower: b.levelLower,
        levelUpper: b.levelUpper,
        liquidity: b.liquidity.toFixed(),
        tokenInventory: b.tokenInventory.toFixed(),
      })),
      fullRange: {
        liquidity: pool.fullRangeLiq?.toFixed() ?? null,
        tickLower: FULL_RANGE_TICK_LOWER,
        tickUpper: FULL_RANGE_TICK_UPPER,
      },
      wall: {
        liquidity: pool.wallLiquidity?.toFixed() ?? null,
        levelLower: (pool.graduationLevel ?? 0) + 1,
        levelUpper: (pool.graduationLevel ?? 0) + WALL_WIDTH_LEVELS,
      },
    };
  }
}

function sqrtAtLevel(level: number): string {
  return sqrtPriceAtLevel(level).toString();
}

function curveProgress(
  pool: { openingLevel: number; farLevel: number; status: string },
  level: number,
): number {
  if (pool.status === 'graduated') return 1;
  const span = pool.farLevel - pool.openingLevel;
  if (span <= 0) return 0;
  const covered = Math.min(Math.max(level - pool.openingLevel, 0), span);
  return covered / span;
}
