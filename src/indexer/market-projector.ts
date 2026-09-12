import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PrismaService } from '../infrastructure/database/prisma.service';
import type { ProjectorContext } from './projection-applier';
import type { DecodedPoolManagerEvent } from './event-decoder';
import { big, ordinalKey } from './ordinal';
import { candleUpsert, ensurePoolStats, poolStatsAdd, protocolDayVolume } from './aggregates';

/**
 * PoolManager / ERC-20 / RevenueNFT appliers: trade tape facts, sqrt-axis
 * minute/hour/day candles, pool + protocol volume rollups, burns, and
 * revenue-NFT ownership.
 *
 * Swap semantics (backend guide §1): `amount0 < 0` means a BUY (ETH in, the
 * caller's signed delta is negative). Stored amounts are absolute values;
 * `is_buy` carries direction. Fees: `input_amount × fee_pips / 1_000_000`.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function floorBucket(ms: number, size: number): Date {
  return new Date(Math.floor(ms / size) * size);
}

@Injectable()
export class MarketProjector {
  private readonly logger = new Logger(MarketProjector.name);

  constructor(private readonly prisma: PrismaService) {}

  async applySwap(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: Extract<DecodedPoolManagerEvent, { name: 'Swap' }>,
  ): Promise<void> {
    const pool = await tx.pool.findUnique({
      where: { chainId_poolId: { chainId: ctx.chainId, poolId: event.poolId } },
    });
    if (!pool) return; // not a Spawn pool

    const isBuy = event.amount0 < 0n;
    const ethAbs = isBuy ? -event.amount0 : event.amount0;
    const tokenAbs = isBuy ? event.amount1 : -event.amount1;
    const feePips = event.lpFee > 0 ? event.lpFee : 10_000;
    const inputAmount = isBuy ? ethAbs : tokenAbs;
    const fee = (inputAmount * BigInt(feePips)) / 1_000_000n;
    const feeEth = isBuy ? fee : 0n;
    const feeTokens = isBuy ? 0n : fee;

    await tx.swapFact.create({
      data: {
        chainId: ctx.chainId,
        ordinalKey: ordinalKey(ctx),
        poolId: event.poolId,
        sender: event.sender,
        isBuy,
        amount0Eth: big(ethAbs),
        amount1Tokens: big(tokenAbs),
        sqrtPriceX96: big(event.sqrtPriceX96),
        tick: event.tick,
        fee: feePips,
        feeEth: big(feeEth),
        feeTokens: big(feeTokens),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        timestamp: ctx.blockTime,
      },
    });

    const buyEth = isBuy ? ethAbs : 0n;
    const sellEth = isBuy ? 0n : ethAbs;
    const buyTokens = isBuy ? tokenAbs : 0n;
    const sellTokens = isBuy ? 0n : tokenAbs;

    await ensurePoolStats(tx, ctx.chainId, event.poolId);
    await poolStatsAdd(
      tx,
      ctx.chainId,
      event.poolId,
      {
        buy_volume_eth: buyEth,
        sell_volume_eth: sellEth,
        buy_volume_tokens: buyTokens,
        sell_volume_tokens: sellTokens,
        swap_count: 1,
      },
      { last_price_sqrt_x96: event.sqrtPriceX96, last_swap_block: ctx.blockNumber },
      {},
      { ath_sqrt_x96: event.sqrtPriceX96 },
    );

    const bucketMs = ctx.blockTime.getTime();
    await candleUpsert(
      tx,
      'pool_minute_stats',
      'minute',
      ctx.chainId,
      event.poolId,
      floorBucket(bucketMs, MINUTE),
      event.sqrtPriceX96,
      buyEth,
      sellEth,
      buyTokens,
      sellTokens,
    );
    await candleUpsert(
      tx,
      'pool_hour_stats',
      'hour',
      ctx.chainId,
      event.poolId,
      floorBucket(bucketMs, HOUR),
      event.sqrtPriceX96,
      buyEth,
      sellEth,
      buyTokens,
      sellTokens,
    );
    await candleUpsert(
      tx,
      'pool_day_stats',
      'day',
      ctx.chainId,
      event.poolId,
      floorBucket(bucketMs, DAY),
      event.sqrtPriceX96,
      buyEth,
      sellEth,
      buyTokens,
      sellTokens,
    );

    await protocolDayVolume(tx, ctx.chainId, ctx.blockTime, buyEth, sellEth, 1n);
  }

  /** ERC-20 Transfer on a launch token: only burns (to 0x0) are indexed as facts. */
  async applyTokenTransfer(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: { token: string; from: string; to: string; value: bigint },
  ): Promise<void> {
    if (event.to !== '0x0000000000000000000000000000000000000000') return;
    const pool = await tx.pool.findUnique({
      where: { chainId_token: { chainId: ctx.chainId, token: event.token } },
    });
    await tx.tokenBurnFact.create({
      data: {
        chainId: ctx.chainId,
        ordinalKey: ordinalKey(ctx),
        poolId: pool?.poolId ?? null,
        token: event.token,
        burner: event.from,
        amount: big(event.value),
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        blockNumber: ctx.blockNumber,
        timestamp: ctx.blockTime,
      },
    });
    if (pool) {
      await ensurePoolStats(tx, ctx.chainId, pool.poolId);
      await poolStatsAdd(tx, ctx.chainId, pool.poolId, { burned_total: event.value });
    }
  }

  /** RevenueNFT Transfer: track the current holder of each pool's creator stream. */
  async applyRevenueNftTransfer(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: { tokenId: bigint; from: string; to: string },
  ): Promise<void> {
    // RevenueNFT.tokenIdOf(poolId) = uint256(poolId) — invert by hex-encoding.
    const poolId = `0x${event.tokenId.toString(16).padStart(64, '0')}`;
    const pool = await tx.pool.findUnique({
      where: { chainId_poolId: { chainId: ctx.chainId, poolId } },
    });
    if (!pool) return;
    await tx.pool.update({
      where: { chainId_poolId: { chainId: ctx.chainId, poolId } },
      data: {
        revenueNftOwner: event.to,
        revenueNftId: big(event.tokenId),
      },
    });
  }
}
