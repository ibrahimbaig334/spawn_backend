import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Address } from 'viem';
import { CACHE_MANAGER } from '../../infrastructure/cache/cache.constants';
import type { DomainCachePort } from '../../infrastructure/cache/domain-cache.port';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const TRANSFER_EVENT = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { type: 'address', indexed: true, name: 'from' },
    { type: 'address', indexed: true, name: 'to' },
    { type: 'uint256', indexed: false, name: 'value' },
  ],
} as const;
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
    @Inject(CACHE_MANAGER) private readonly cache: DomainCachePort,
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

  private readonly quoteCache = new Map<string, { value: Record<string, unknown>; expires: number }>();
  private readonly quoteInFlight = new Map<string, Promise<Record<string, unknown>>>();

  /**
   * Quotes are eth_calls into the hook-simulating V4Quoter — the most expensive
   * read in the API. Identical requests inside the TTL share one on-chain call
   * (cache + in-flight coalescing); the client debounces, so bursts collapse.
   */
  private async cachedQuote(
    key: string,
    compute: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const now = Date.now();
    const hit = this.quoteCache.get(key);
    if (hit && hit.expires > now) return hit.value;
    const pending = this.quoteInFlight.get(key);
    if (pending) return pending;
    const promise = compute()
      .then((value) => {
        this.quoteCache.set(key, { value, expires: Date.now() + this.QUOTE_TTL_MS });
        return value;
      })
      .finally(() => {
        this.quoteInFlight.delete(key);
      });
    this.quoteInFlight.set(key, promise);
    return promise;
  }

  private readonly QUOTE_TTL_MS = 1_500;

  async quote(tokenRef: string, query: QuoteQueryDto) {
    const chainId = resolveChainId(query.chainId);
    const pool = await this.poolOrThrow(tokenRef, chainId);
    const key = `${chainId}:${pool.poolId}:${query.side}:${query.amount}`;
    return this.cachedQuote(key, () => this.computeQuote(tokenRef, query));
  }

  private async computeQuote(tokenRef: string, query: QuoteQueryDto) {
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

  /**
   * Largest buy the bonding curve can currently fill, found by searching the
   * real quoter server-side (near the node: ~10 eth_calls, no HTTP hops) and
   * cached per pool. Frontend min()s this with balance minus gas, then
   * re-quotes once for the exact figure.
   */
  async maxBuy(tokenRef: string) {
    const chainId = resolveChainId({});
    const pool = await this.poolOrThrow(tokenRef, chainId);
    if (pool.status !== 'bonding') {
      return { poolId: pool.poolId, chainId, curveCapWei: null, maxEthWei: null, note: 'Graduated markets have no curve cap.' };
    }
    const key = `${chainId}:${pool.poolId}:max-buy`;
    return this.cachedQuote(key, async () => {
      const quotable = async (amount: bigint): Promise<boolean> => {
        try {
          await this.computeQuote(tokenRef, { side: 'BUY', amount: amount.toString(), chainId } as QuoteQueryDto);
          return true;
        } catch {
          return false;
        }
      };
      let hi = 1n * 10n ** 18n;
      if (await quotable(hi)) {
        // Double until the curve can't fill it (bounded: the curve caps ~ ETH-scale).
        for (let i = 0; i < 6 && (await quotable(hi)); i += 1) hi *= 4n;
      }
      let lo = 0n;
      for (let i = 0; i < 12 && hi - lo > 10n ** 14n; i += 1) {
        const mid = (lo + hi) / 2n;
        if (await quotable(mid)) lo = mid;
        else hi = mid;
      }
      return {
        poolId: pool.poolId,
        chainId,
        curveCapWei: lo.toString(),
        maxEthWei: lo.toString(),
        note: 'Largest curve-fillable buy. Combine with wallet balance minus gas, then re-quote for the exact amount.',
      };
    });
  }

  /**
   * Holder snapshot computed on demand from ERC-20 Transfer logs since the
   * launch block (viem getLogs, balances folded in-memory). Cached 60s —
   * this is a display metric, not accounting. Bails out on very hot tokens
   * rather than hammering the RPC.
   */
  async holders(tokenRef: string) {
    const chainId = resolveChainId({});
    const pool = await this.poolOrThrow(tokenRef, chainId);
    const cacheKey = `holders:${chainId}:${pool.poolId}`;
    const cached = await this.cache.get<Record<string, unknown>>(cacheKey);
    if (cached) return cached;

    // Preferred source: the token_holders table folded by the substreams
    // sink (exact balances, one indexed query). getLogs is the fallback for
    // chains/pools the sink hasn't covered.
    const indexed = await this.prisma.$queryRawUnsafe<
      { holder: string; balance: string }[]
    >(
      `SELECT "holder", balance::text AS balance FROM token_holders
       WHERE token = '${pool.token.toLowerCase()}' AND balance > 0
       ORDER BY balance DESC LIMIT 10`,
    );
    if (indexed.length > 0) {
      const countRows = await this.prisma.$queryRawUnsafe<{ c: number }[]>(
        `SELECT count(*)::int AS c FROM token_holders
         WHERE token = '${pool.token.toLowerCase()}' AND balance > 0`,
      );
      const totalBal = indexed.reduce((sum, row) => sum + BigInt(row.balance), 0n);
      const topTotal = totalBal > 0n ? totalBal : 1n;
      const computed = {
        poolId: pool.poolId,
        chainId,
        available: true as const,
        holdersCount: countRows[0]?.c ?? 0,
        topHolders: indexed.map((row) => ({
          address: row.holder,
          balance: row.balance,
          shareBps: Number((BigInt(row.balance) * 10_000n) / topTotal),
        })),
        computedAt: new Date().toISOString(),
        source: 'indexer',
      };
      await this.cache.set(cacheKey, computed, { ttlSeconds: 60 });
      return computed;
    }

    const computed = await (async () => {
      const client = this.clientFactory.client(chainId);
      const token = pool.token as Address;
      const fromBlock = BigInt(pool.launchBlock.toString());
      const logs = await client.getLogs({
        address: token,
        event: TRANSFER_EVENT,
        args: {},
        fromBlock,
      });
      if (logs.length > 20_000) {
        return { poolId: pool.poolId, chainId, available: false as const, note: 'Too many transfers to fold cheaply.' };
      }
      const balances = new Map<string, bigint>();
      for (const log of logs) {
        const args = log.args as { from?: Address; to?: Address; value?: bigint };
        const { from, to, value } = args;
        if (!from || !to || value === undefined) continue;
        const amount = value;
        if (from !== ZERO_ADDRESS) balances.set(from, (balances.get(from) ?? 0n) - amount);
        if (to !== ZERO_ADDRESS) balances.set(to, (balances.get(to) ?? 0n) + amount);
      }
      const holders = [...balances.entries()].filter(([, balance]) => balance > 0n);
      const total = holders.reduce((sum, [, balance]) => sum + balance, 0n);
      const top = holders
        .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
        .slice(0, 10)
        .map(([address, balance]) => ({
          address,
          balance: balance.toString(),
          shareBps: total > 0n ? Number((balance * 10_000n) / total) : 0,
        }));
      return {
        poolId: pool.poolId,
        chainId,
        available: true as const,
        holdersCount: holders.length,
        topHolders: top,
        computedAt: new Date().toISOString(),
        source: 'rpc',
      };
    })();

    await this.cache.set(cacheKey, computed, { ttlSeconds: 60 });
    return computed;
  }

  /**
   * Per-wallet position ledger: the wallet's swaps per pool from
   * swaps.trader (transaction signer), folded into avg-cost basis with
   * bigint math. Buys add cost, sells realize against the running average.
   * Realized PnL is in ETH; unrealized values the remaining tokens at the
   * pool's last traded price.
   */
  /**
   * The wallet's own trade history across every pool, from swaps.trader
   * (transaction signer). The per-pool /trades endpoint exposes only the
   * swap-event sender, which is the router for routed trades — trader is
   * the wallet-attributed column.
   */
  async walletTrades(wallet: string, page: number, limit: number, chainIdQuery?: number) {
    const chainId = resolveChainId(chainIdQuery);
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const offset = (Math.max(page, 1) - 1) * safeLimit;
    const w = wallet.toLowerCase().replace(/'/g, "''");
    const [total, rows] = await Promise.all([
      this.prisma.$queryRawUnsafe<{ c: number }[]>(
        `SELECT count(*)::int AS c FROM swaps WHERE "chain_id" = ${chainId} AND lower(trader) = '${w}'`,
      ),
      this.prisma.$queryRawUnsafe<
        {
          pool_id: string; token: string; symbol: string | null; name: string | null;
          is_buy: boolean; amount0_eth: string; amount1_tokens: string;
          sqrt_price_x96: string; tx_hash: string; log_index: number;
          block_number: string; timestamp: Date;
        }[]
      >(
        `SELECT s."pool_id", s.token, t.symbol, t.name, s.is_buy,
                s."amount0_eth"::text AS "amount0_eth", s."amount1_tokens"::text AS "amount1_tokens",
                s."sqrt_price_x96"::text AS "sqrt_price_x96",
                s."tx_hash", s."log_index", s."block_number"::text AS "block_number", s."timestamp"
         FROM swaps s
         LEFT JOIN tokens t ON t."chain_id" = s."chain_id" AND t.token = s.token
         WHERE s."chain_id" = ${chainId} AND lower(s.trader) = '${w}'
         ORDER BY s."block_number" DESC, s."log_index" DESC
         LIMIT ${safeLimit} OFFSET ${offset}`,
      ),
    ]);
    const count = total[0]?.c ?? 0;
    return {
      data: rows.map((r) => ({
        poolId: r.pool_id,
        token: r.token,
        symbol: r.symbol,
        name: r.name,
        transactionHash: r.tx_hash,
        logIndex: r.log_index,
        blockNumber: r.block_number,
        timestamp: r.timestamp,
        side: r.is_buy ? 'BUY' : 'SELL',
        ethAmount: r.amount0_eth,
        tokenAmount: r.amount1_tokens,
        sqrtPriceX96: r.sqrt_price_x96,
        priceEth: sqrtToEthString(BigInt(r.sqrt_price_x96)),
      })),
      meta: { page, limit: safeLimit, total: count, totalPages: Math.max(1, Math.ceil(count / safeLimit)) },
    };
  }

  async walletPnl(wallet: string) {
    const chainId = resolveChainId({});
    const rows = await this.prisma.$queryRawUnsafe<
      {
        pool_id: string; token: string; symbol: string | null; name: string | null;
        is_buy: boolean; amount0_eth: string; amount1_tokens: string;
      }[]
    >(
      `SELECT s."pool_id", s.token, t.symbol, t.name, s.is_buy,
              s."amount0_eth"::text AS "amount0_eth", s."amount1_tokens"::text AS "amount1_tokens"
       FROM swaps s
       LEFT JOIN tokens t ON t."chain_id" = s."chain_id" AND t.token = s.token
       WHERE s."chain_id" = ${chainId} AND lower(s.trader) = '${wallet.toLowerCase()}'
       ORDER BY s."block_number" ASC, s."log_index" ASC`,
    );

    type Position = {
      poolId: string; token: string; symbol: string | null; name: string | null;
      tokensHeld: bigint; costEth: bigint; realizedEth: bigint; trades: number;
    };
    const byPool = new Map<string, Position>();
    for (const row of rows) {
      let pos = byPool.get(row.pool_id);
      if (!pos) {
        pos = {
          poolId: row.pool_id, token: row.token, symbol: row.symbol ?? null, name: row.name ?? null,
          tokensHeld: 0n, costEth: 0n, realizedEth: 0n, trades: 0,
        };
        byPool.set(row.pool_id, pos);
      }
      const eth = BigInt(row.amount0_eth);
      const tokens = BigInt(row.amount1_tokens);
      pos.trades += 1;
      if (row.is_buy) {
        pos.tokensHeld += tokens;
        pos.costEth += eth;
      } else if (pos.tokensHeld > 0n) {
        // Realize proportional to cost basis share sold.
        const costSold = (pos.costEth * tokens) / pos.tokensHeld;
        pos.realizedEth += eth - costSold;
        pos.costEth -= costSold;
        pos.tokensHeld -= tokens;
      } else {
        // Selling more than tracked (bought pre-tracking): treat proceeds as realized.
        pos.realizedEth += eth;
      }
    }

    // Burned tokens leave the wallet without a swap (user burn(), fee burns
    // routed through the wallet). Debit them from the folded positions so the
    // ledger matches live balanceOf — otherwise every burn inflates holdings.
    const burnRows = await this.prisma.$queryRawUnsafe<
      { token: string; burned: string }[]
    >(
      `SELECT token, SUM(amount)::text AS burned
       FROM token_burns
       WHERE "chain_id" = ${chainId} AND lower(burner) = '${wallet.toLowerCase()}'
       GROUP BY token`,
    );
    const burnsByToken = new Map(burnRows.map((r) => [r.token.toLowerCase(), BigInt(r.burned)]));
    if (burnsByToken.size > 0) {
      for (const pos of byPool.values()) {
        const burned = burnsByToken.get(pos.token.toLowerCase());
        if (burned === undefined) continue;
        const debited = burned > pos.tokensHeld ? pos.tokensHeld : burned;
        // Burns remove tokens that were paid for: realize the cost at the
        // average basis, exactly like a sell, but with zero ETH proceeds.
        const costBurned = pos.tokensHeld > 0n ? (pos.costEth * debited) / pos.tokensHeld : 0n;
        pos.costEth -= costBurned;
        pos.realizedEth -= costBurned;
        pos.tokensHeld -= debited;
      }
    }

    const lastPrices = await this.prisma.$queryRawUnsafe<
      { pool_id: string; sqrt: string }[]
    >(
      `SELECT ps."pool_id", ps."last_price_sqrt_x96"::text AS sqrt
       FROM pool_stats ps
       WHERE ps."chain_id" = ${chainId}`,
    );
    const priceByPool = new Map(lastPrices.map((r) => [r.pool_id, BigInt(r.sqrt)]));

    const positions = [...byPool.values()].map((pos) => {
      const sqrt = priceByPool.get(pos.poolId) ?? 0n;
      // token price in ETH-wei = 2^192 / sqrt^2 (inverted axis)
      const unrealizedEth =
        sqrt > 0n && pos.tokensHeld > 0n ? (pos.tokensHeld << 192n) / (sqrt * sqrt) : 0n;
      const cost = pos.costEth;
      const value = unrealizedEth;
      return {
        poolId: pos.poolId,
        token: pos.token,
        symbol: pos.symbol,
        name: pos.name,
        trades: pos.trades,
        tokensHeld: pos.tokensHeld.toString(),
        costEth: cost.toString(),
        valueEth: value.toString(),
        realizedPnlEth: pos.realizedEth.toString(),
        unrealizedPnlEth: (value - cost).toString(),
      };
    });

    const sum = (pick: (p: (typeof positions)[number]) => string) =>
      positions.reduce((acc, p) => acc + BigInt(pick(p)), 0n).toString();
    return {
      chainId,
      wallet: wallet.toLowerCase(),
      totals: {
        realizedPnlEth: sum((p) => p.realizedPnlEth),
        unrealizedPnlEth: sum((p) => p.unrealizedPnlEth),
        costEth: sum((p) => p.costEth),
        valueEth: sum((p) => p.valueEth),
      },
      positions,
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
