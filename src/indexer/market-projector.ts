import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PrismaService } from '../infrastructure/database/prisma.service';
import { bigToDecimal, decimalToBig } from './decimal-utils';
import { toLevel } from '../protocol/protocol-math';
import type { ProjectorContext } from './projection-applier';
import type { DecodedPoolManagerEvent } from './event-decoder';

/**
 * PoolManager / ERC-20 / RevenueNFT event projectors: the trade tape, OHLCV
 * candles, holdings, circulating supply, and revenue-NFT ownership.
 *
 * Trade semantics (integration guide §8.2):
 * - A buy is `zeroForOne` (ETH in, token out): `Swap.amount0 < 0`, ETH volume is
 *   `-amount0` (includes the 1% fee on the input side), token volume `-amount1`.
 * - A sell is the reverse: token volume `-amount1`, ETH proceeds `amount0`.
 * - `level = -tick` from the swap's end tick.
 */

const CANDLE_INTERVALS: Array<{ key: 'M1' | 'M5' | 'M15' | 'H1' | 'H4' | 'D1'; seconds: number }> =
  [
    { key: 'M1', seconds: 60 },
    { key: 'M5', seconds: 300 },
    { key: 'M15', seconds: 900 },
    { key: 'H1', seconds: 3600 },
    { key: 'H4', seconds: 14400 },
    { key: 'D1', seconds: 86400 },
  ];

export type SwapContext = ProjectorContext & { traderWallet: string | null };

@Injectable()
export class MarketProjector {
  private readonly logger = new Logger(MarketProjector.name);

  constructor(private readonly prisma: PrismaService) {}

  async applySwap(
    tx: Prisma.TransactionClient,
    ctx: SwapContext,
    event: Extract<DecodedPoolManagerEvent, { name: 'Swap' }>,
  ): Promise<void> {
    const state = await tx.tokenChainState.findUnique({
      where: { chainId_poolId: { chainId: ctx.chainId, poolId: event.poolId } },
    });
    if (!state) return; // not a Spawn pool (hook filter upstream); ignore

    const isBuy = event.amount0 < 0n;
    const side: 'BUY' | 'SELL' = isBuy ? 'BUY' : 'SELL';
    // Signed amounts are caller-perspective deltas including the input-side fee.
    const quoteAmountRaw = isBuy ? -event.amount0 : event.amount0;
    const tokenAmountRaw = isBuy ? -event.amount1 : event.amount1;
    const level = toLevel(event.tick);

    const traderWallet = ctx.traderWallet ?? event.sender;

    await tx.trade.create({
      data: {
        chainId: ctx.chainId,
        transactionHash: ctx.txHash,
        logIndex: ctx.logIndex,
        transactionIndex: 0, // filled by the ingest loop when available
        tokenId: state.tokenId,
        side,
        traderWallet,
        tokenAmountRaw: bigToDecimal(tokenAmountRaw),
        quoteAmountRaw: bigToDecimal(quoteAmountRaw),
        priceLevel: level,
        sqrtPriceX96: bigToDecimal(event.sqrtPriceX96),
        lpFee: event.lpFee,
        blockNumber: ctx.blockNumber,
        blockHash: '0x' + '0'.repeat(64), // filled by the ingest loop
        blockTime: ctx.blockTime,
        projectionVersion: ctx.version,
      },
    });

    await tx.tokenChainState.update({
      where: { tokenId: state.tokenId },
      data: {
        lastPriceLevel: level,
        lastSqrtPriceX96: bigToDecimal(event.sqrtPriceX96),
        projectionVersion: ctx.version,
        sourceBlockNumber: ctx.blockNumber,
        sourceBlockTime: ctx.blockTime,
      },
    });

    // Candles keyed on ETH volume (quote); USD enrichment happens in the metrics pass.
    // Levels: open is the first trade's level in the bucket; high/low are running
    // extremes; close is the latest. Read-then-write (Prisma has no max/min update).
    for (const interval of CANDLE_INTERVALS) {
      const bucketStart = new Date(
        Math.floor(ctx.blockTime.getTime() / (interval.seconds * 1000)) * interval.seconds * 1000,
      );
      const volumeEth = bigToDecimal(quoteAmountRaw);
      const existing = await tx.candle.findUnique({
        where: {
          tokenId_chainId_interval_bucketStart: {
            tokenId: state.tokenId,
            chainId: ctx.chainId,
            interval: interval.key,
            bucketStart,
          },
        },
      });
      if (!existing) {
        await tx.candle.create({
          data: {
            tokenId: state.tokenId,
            chainId: ctx.chainId,
            interval: interval.key,
            bucketStart,
            open: level,
            high: level,
            low: level,
            close: level,
            volumeEth,
            tradeCount: 1n,
            projectionVersion: ctx.version,
          },
        });
      } else {
        await tx.candle.update({
          where: {
            tokenId_chainId_interval_bucketStart: {
              tokenId: state.tokenId,
              chainId: ctx.chainId,
              interval: interval.key,
              bucketStart,
            },
          },
          data: {
            high: Math.max(existing.high.toNumber(), level),
            low: Math.min(existing.low.toNumber(), level),
            close: level,
            volumeEth: { increment: volumeEth },
            tradeCount: { increment: 1n },
            projectionVersion: ctx.version,
          },
        });
      }
    }

    // Update metrics for all timeframes (trade count + volume accrue per trade).
    await this.updateMetricCounters(tx, ctx, state.tokenId, quoteAmountRaw);
  }

  private async updateMetricCounters(
    tx: Prisma.TransactionClient,
    ctx: SwapContext,
    tokenId: string,
    quoteAmountRaw: bigint,
  ): Promise<void> {
    const volumeEth = bigToDecimal(quoteAmountRaw);
    for (const timeframe of ['H1', 'H24', 'D7', 'D30', 'ALL'] as const) {
      await tx.tokenMetric.upsert({
        where: { tokenId_chainId_timeframe: { tokenId, chainId: ctx.chainId, timeframe } },
        create: {
          tokenId,
          chainId: ctx.chainId,
          timeframe,
          volumeEth,
          tradeCount: 1n,
          projectionVersion: ctx.version,
          sourceBlockNumber: ctx.blockNumber,
          sourceBlockTime: ctx.blockTime,
        },
        update: {
          volumeEth: { increment: volumeEth },
          tradeCount: { increment: 1n },
          projectionVersion: ctx.version,
          sourceBlockNumber: ctx.blockNumber,
          sourceBlockTime: ctx.blockTime,
        },
      });
    }
  }

  /** Applies an ERC-20 Transfer on a launch token: holdings, supply on burn, launch-mint. */
  async applyTokenTransfer(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: { token: string; from: string; to: string; value: bigint },
  ): Promise<void> {
    const state = await tx.tokenChainState.findUnique({
      where: { chainId_contractAddress: { chainId: ctx.chainId, contractAddress: event.token } },
    });
    if (!state) return; // not a launch token

    const ZERO = '0x0000000000000000000000000000000000000000';
    if (event.from === ZERO && event.to === state.contractAddress) {
      return; // genesis mint to the hook; supply already recorded at Launched
    }

    if (event.from === ZERO) {
      // Any other mint is impossible post-launch per the protocol; ignore defensively.
      return;
    }

    if (event.to === ZERO) {
      // Burn (sell-fee residue, buyback-and-burn): supply falls; holder decrement below.
      await tx.tokenChainState.update({
        where: { tokenId: state.tokenId },
        data: {
          currentSupply: { decrement: bigToDecimal(event.value) },
          projectionVersion: ctx.version,
          sourceBlockNumber: ctx.blockNumber,
          sourceBlockTime: ctx.blockTime,
        },
      });
      await this.adjustHolding(tx, ctx, state.tokenId, event.from, -event.value);
      return;
    }

    if (event.value === 0n) return;

    await this.adjustHolding(tx, ctx, state.tokenId, event.from, -event.value);
    await this.adjustHolding(tx, ctx, state.tokenId, event.to, event.value);
  }

  private async adjustHolding(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    tokenId: string,
    wallet: string,
    delta: bigint,
  ): Promise<void> {
    const existing = await tx.holding.findUnique({
      where: {
        walletAddress_tokenId_chainId: { walletAddress: wallet, tokenId, chainId: ctx.chainId },
      },
    });
    if (!existing) {
      if (delta < 0n) return; // transfer from a wallet we never saw receive; skip (partial index)
      await tx.holding.create({
        data: {
          walletAddress: wallet,
          tokenId,
          chainId: ctx.chainId,
          balanceRaw: bigToDecimal(delta),
          lastActivityAt: ctx.blockTime,
          projectionVersion: ctx.version,
          sourceBlockNumber: ctx.blockNumber,
          sourceBlockTime: ctx.blockTime,
        },
      });
      await this.bumpHolderCount(tx, ctx, tokenId, 1n);
      return;
    }
    const next = decimalToBig(existing.balanceRaw) + delta;
    if (next <= 0n) {
      await tx.holding.delete({
        where: {
          walletAddress_tokenId_chainId: { walletAddress: wallet, tokenId, chainId: ctx.chainId },
        },
      });
      await this.bumpHolderCount(tx, ctx, tokenId, -1n);
      return;
    }
    await tx.holding.update({
      where: {
        walletAddress_tokenId_chainId: { walletAddress: wallet, tokenId, chainId: ctx.chainId },
      },
      data: {
        balanceRaw: bigToDecimal(next),
        lastActivityAt: ctx.blockTime,
        projectionVersion: ctx.version,
        sourceBlockNumber: ctx.blockNumber,
        sourceBlockTime: ctx.blockTime,
      },
    });
  }

  private async bumpHolderCount(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    tokenId: string,
    delta: bigint,
  ): Promise<void> {
    for (const timeframe of ['ALL'] as const) {
      await tx.tokenMetric.upsert({
        where: { tokenId_chainId_timeframe: { tokenId, chainId: ctx.chainId, timeframe } },
        create: {
          tokenId,
          chainId: ctx.chainId,
          timeframe,
          holderCount: delta > 0n ? 1n : 0n,
          tradeCount: 0n,
          projectionVersion: ctx.version,
          sourceBlockNumber: ctx.blockNumber,
          sourceBlockTime: ctx.blockTime,
        },
        update: {
          holderCount: { increment: Number(delta) },
          projectionVersion: ctx.version,
        },
      });
    }
  }

  /** RevenueNFT Transfer: track the current holder of each pool's creator stream. */
  async applyRevenueNftTransfer(
    tx: Prisma.TransactionClient,
    ctx: ProjectorContext,
    event: { tokenId: bigint; from: string; to: string },
    poolIdForTokenId: (nftTokenId: bigint) => string | null,
  ): Promise<void> {
    const poolId = poolIdForTokenId(event.tokenId);
    if (!poolId) return;
    const state = await tx.tokenChainState.findUnique({
      where: { chainId_poolId: { chainId: ctx.chainId, poolId } },
    });
    if (!state) return;
    const ZERO = '0x0000000000000000000000000000000000000000';
    await tx.tokenChainState.update({
      where: { tokenId: state.tokenId },
      data: {
        creatorRevenueOwner: event.to === ZERO ? null : event.to,
        creatorRevenueNftId: bigToDecimal(event.tokenId),
        revenueNftMintedAt: event.from === ZERO ? ctx.blockTime : state.revenueNftMintedAt,
        projectionVersion: ctx.version,
        sourceBlockNumber: ctx.blockNumber,
        sourceBlockTime: ctx.blockTime,
      },
    });
  }
}
