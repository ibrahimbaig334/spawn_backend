import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { BlockchainRegistryService } from '../../infrastructure/blockchain/blockchain-registry.service';
import { ProtocolReadService } from '../../infrastructure/blockchain/protocol-read.service';
import { ChainClientFactory } from '../../infrastructure/blockchain/chain-client.factory';
import { V4_QUOTER_ABI } from '../../infrastructure/blockchain/contract-abis';
import { spawnPoolKey } from '../../infrastructure/blockchain/contract-readers';
import { decimalToBig } from '../../indexer/decimal-utils';
import {
  toLevel,
  fdvEthWeiAtSqrtPrice,
  curvePositionLiquidity,
  curvePositionStart,
  tokenPriceEthString,
  fdvEthWeiAtLevel,
} from '../../protocol/protocol-math';
import { EthUsdOracle } from '../../infrastructure/blockchain/eth-usd-oracle';

/**
 * Trading reads: live price (level space), V4Quoter swaps, and ladder depth.
 * Everything user-facing is level-space; the tick boundary is crossed exactly once.
 */

@Injectable()
export class TradingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: BlockchainRegistryService,
    private readonly protocolReads: ProtocolReadService,
    private readonly clientFactory: ChainClientFactory,
    private readonly oracle: EthUsdOracle,
  ) {}

  private async resolveToken(chainId: number, tokenRef: string) {
    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      tokenRef,
    );
    const committed = await this.prisma.chainWatermark.findUnique({ where: { chainId } });
    if (!committed)
      throw new NotFoundException({
        code: 'TOKEN_NOT_FOUND',
        message: 'no committed projections yet',
      });
    const token = await this.prisma.token.findFirst({
      where: uuidLike
        ? { id: tokenRef, chainId }
        : { chainId, projection: { contractAddress: tokenRef.toLowerCase() } },
      include: { projection: true },
    });
    if (!token?.projection)
      throw new NotFoundException({
        code: 'TOKEN_NOT_FOUND',
        message: `token ${tokenRef} not found`,
      });
    return token;
  }

  async price(tokenRef: string, query: { chainId?: number }): Promise<TokenPricePresenter> {
    const chainId = query.chainId ?? Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
    const token = await this.resolveToken(chainId, tokenRef);
    const state = token.projection!;

    // Prefer the last indexer-seen price; fall back to a live slot0 read.
    let level = state.lastPriceLevel ?? state.openingLevel;
    let sqrtPriceX96: bigint | null = state.lastSqrtPriceX96
      ? decimalToBig(state.lastSqrtPriceX96)
      : null;
    try {
      const slot0 = await this.protocolReads.slot0(chainId, state.poolId);
      if (slot0) {
        level = toLevel(slot0.tick);
        sqrtPriceX96 = slot0.sqrtPriceX96;
      }
    } catch {
      // keep indexer value
    }

    const totalSupplyWei = decimalToBig(state.totalSupply);
    const fdvEth = sqrtPriceX96
      ? fdvEthWeiAtSqrtPrice(totalSupplyWei, sqrtPriceX96)
      : fdvEthWeiAtLevel(totalSupplyWei, level);
    const ethUsd = await this.oracle.ethUsd(chainId).catch(() => null);

    const progress = curveProgress(state, level);

    return {
      tokenId: token.id,
      chainId,
      contractAddress: state.contractAddress,
      poolId: state.poolId,
      phase: state.phase,
      level,
      tick: -level,
      sqrtPriceX96: sqrtPriceX96 ? sqrtPriceX96.toString() : null,
      priceEthPerToken: tokenPriceEthString(level, state.decimals),
      fdvEth: fdvEth.toString(),
      fdvUsd: ethUsd ? scaleUsd(fdvEth, ethUsd) : null,
      ethUsd: ethUsd ? ethUsd.toString() : null,
      openingLevel: state.openingLevel,
      farLevel: state.farLevel,
      graduationLevel: state.graduationLevel,
      progress,
    };
  }

  async quote(
    tokenRef: string,
    query: { side: 'BUY' | 'SELL'; amount: string; chainId?: number },
  ): Promise<QuotePresenter> {
    const chainId = query.chainId ?? Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
    const token = await this.resolveToken(chainId, tokenRef);
    const state = token.projection!;
    const book = this.registry.book(chainId);
    if (!book.v4Quoter) {
      throw new NotFoundException({
        code: 'QUOTER_NOT_CONFIGURED',
        message: 'V4Quoter address is not configured for this chain',
      });
    }

    const client = this.clientFactory.client(chainId);
    const poolKey = spawnPoolKey(book, state.contractAddress);
    const amount = BigInt(query.amount);
    const zeroForOne = query.side === 'BUY'; // ETH in, token out

    const [amountOut, gasEstimate] = (await client.readContract({
      address: book.v4Quoter as `0x${string}`,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          poolKey: poolKey as never,
          zeroForOne,
          exactAmount:
            amount > 0xffffffffffffffffffffffffffffffffn
              ? 0xffffffffffffffffffffffffffffffffn
              : amount,
          hookData: '0x',
        },
      ] as never,
    })) as [bigint, bigint];
    const inCurrency = zeroForOne ? 'ETH' : token.symbol;
    const outCurrency = zeroForOne ? token.symbol : 'ETH';
    const outAmount = amountOut.toString();

    return {
      tokenId: token.id,
      chainId,
      side: query.side,
      amountIn: query.amount,
      amountInCurrency: inCurrency,
      amountOut: outAmount,
      amountOutCurrency: outCurrency,
      gasEstimate: gasEstimate.toString(),
      executedPriceNote:
        'gas estimates taken from a quote are not the same as real swaps (JIT deploys cost gas on execution)',
    };
  }

  async depth(
    tokenRef: string,
    query: { buckets?: number; chainId?: number },
  ): Promise<DepthPresenter> {
    const chainId = query.chainId ?? Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
    const token = await this.resolveToken(chainId, tokenRef);
    const state = token.projection!;

    const template = await this.protocolReads.template(chainId);
    const level = state.lastPriceLevel ?? state.openingLevel;
    const totalSupply = decimalToBig(state.totalSupply);
    const curveSupply = (totalSupply * template.curveSupplyShareWad) / 10n ** 18n;

    const ladder: Array<{
      index: number;
      kind: 'CORE' | 'EXTENSION';
      levelLower: number;
      levelUpper: number;
      tokenInventoryRaw: string;
    }> = [];
    if (state.phase === 'GRADUATED') {
      const graduation = state.graduationLevel ?? level;
      const milestones = await this.prisma.milestone.findMany({
        where: { tokenId: token.id, chainId, state: { in: ['DEPLOYED'] } },
        orderBy: { index: 'asc' },
        take: query.buckets ?? 8,
      });
      for (const m of milestones) {
        ladder.push({
          index: m.index,
          kind: m.kind,
          levelLower: m.levelLower,
          levelUpper: m.levelUpper,
          tokenInventoryRaw: m.tokenInventoryRaw.toFixed(),
        });
      }
      void graduation;
    }

    const curve: Array<{ position: number; startLevel: number; liquidity: string }> = [];
    if (state.phase === 'BONDING_CURVE') {
      for (let i = 0; i < template.curvePositions; i += 1) {
        const start = curvePositionStart(
          state.openingLevel,
          state.farLevel,
          template.curvePositions,
          i,
        );
        if (start < level) continue;
        curve.push({
          position: i,
          startLevel: start,
          liquidity: curvePositionLiquidity(
            state.openingLevel,
            state.farLevel,
            template.curvePositions,
            curveSupply,
            i,
          ).toString(),
        });
        if (curve.length >= (query.buckets ?? 8)) break;
      }
    }

    return {
      tokenId: token.id,
      chainId,
      phase: state.phase,
      level,
      curve,
      ladder,
    };
  }
}

function curveProgress(
  state: {
    phase: string;
    openingLevel: number;
    farLevel: number;
    curveDeployed: number;
    curvePositions: number;
  },
  level: number,
): number {
  if (state.phase === 'GRADUATED') return 1;
  const span = state.farLevel - state.openingLevel;
  if (span <= 0) return 0;
  const covered = Math.min(Math.max(level - state.openingLevel, 0), span);
  return covered / span;
}

function scaleUsd(ethWei: bigint, ethUsd: bigint): string {
  // USD = eth(wei)/1e18 * usd(8 decimals) / 1e8
  return ((ethWei * ethUsd) / 10n ** 18n / 10n ** 8n).toString();
}

export type TokenPricePresenter = {
  tokenId: string;
  chainId: number;
  contractAddress: string;
  poolId: string;
  phase: string;
  level: number;
  tick: number;
  sqrtPriceX96: string | null;
  priceEthPerToken: string;
  fdvEth: string;
  fdvUsd: string | null;
  ethUsd: string | null;
  openingLevel: number;
  farLevel: number;
  graduationLevel: number | null;
  progress: number;
};

export type QuotePresenter = {
  tokenId: string;
  chainId: number;
  side: 'BUY' | 'SELL';
  amountIn: string;
  amountInCurrency: string;
  amountOut: string;
  amountOutCurrency: string;
  gasEstimate: string;
  executedPriceNote: string;
};

export type DepthPresenter = {
  tokenId: string;
  chainId: number;
  phase: string;
  level: number;
  curve: Array<{ position: number; startLevel: number; liquidity: string }>;
  ladder: Array<{
    index: number;
    kind: string;
    levelLower: number;
    levelUpper: number;
    tokenInventoryRaw: string;
  }>;
};
