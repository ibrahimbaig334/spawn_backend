import { Prisma } from '../infrastructure/database/prisma.service';

/**
 * Sink-style aggregate maintenance via single-statement upserts:
 *   ADD: col = col + value          MAX/MIN: greatest/least
 *   SET: overwrite (last write)     SET_IF_NULL: first write wins (candle open)
 * These columns are maintained only by these delta-ops (backend guide §1).
 */

function big(v: bigint | number): string {
  return v.toString();
}

/** Ensure the per-pool rollup row exists so UPDATE/ADD paths are safe. */
export async function ensurePoolStats(
  tx: Prisma.TransactionClient,
  chainId: number,
  poolId: string,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO pool_stats ("chain_id", "pool_id", "last_price_sqrt_x96") VALUES (${chainId}, '${poolId}', 0)
     ON CONFLICT ("chain_id", "pool_id") DO NOTHING`,
  );
}

export async function poolStatsAdd(
  tx: Prisma.TransactionClient,
  chainId: number,
  poolId: string,
  add: Record<string, bigint | number>,
  set: Record<string, bigint | number> = {},
  maxes: Record<string, bigint> = {},
  mins: Record<string, bigint> = {},
): Promise<void> {
  await ensurePoolStats(tx, chainId, poolId);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(add)) parts.push(`"${k}" = pool_stats."${k}" + ${big(v)}`);
  for (const [k, v] of Object.entries(set)) parts.push(`"${k}" = ${big(v)}`);
  for (const [k, v] of Object.entries(maxes))
    parts.push(`"${k}" = GREATEST(pool_stats."${k}", ${big(v)})`);
  for (const [k, v] of Object.entries(mins))
    parts.push(`"${k}" = LEAST(pool_stats."${k}", ${big(v)})`);
  if (parts.length === 0) return;
  await tx.$executeRawUnsafe(
    `UPDATE pool_stats SET ${parts.join(', ')}, "updated_at" = now() WHERE "chain_id" = ${chainId} AND "pool_id" = '${poolId}'`,
  );
}

/**
 * Candle upsert on the raw sqrt axis (backend guide §3): open = first write,
 * close = last write, high = GREATEST(sqrt), low = LEAST(sqrt).
 */
export async function candleUpsert(
  tx: Prisma.TransactionClient,
  table: 'pool_minute_stats' | 'pool_hour_stats' | 'pool_day_stats',
  timeCol: 'minute' | 'hour' | 'day',
  chainId: number,
  poolId: string,
  bucket: Date,
  sqrt: bigint,
  buyEth: bigint,
  sellEth: bigint,
  buyTokens: bigint,
  sellTokens: bigint,
): Promise<void> {
  await tx.$executeRawUnsafe(`
    INSERT INTO ${table}
      ("chain_id", "pool_id", "${timeCol}", "open_sqrt_x96", "close_sqrt_x96", "high_sqrt_x96", "low_sqrt_x96",
       "buy_volume_eth", "sell_volume_eth", "buy_volume_tokens", "sell_volume_tokens", swap_count, "updated_at")
    VALUES (${chainId}, '${poolId}', '${bucket.toISOString()}', ${sqrt}, ${sqrt}, ${sqrt}, ${sqrt},
            ${buyEth}, ${sellEth}, ${buyTokens}, ${sellTokens}, 1, now())
    ON CONFLICT ("chain_id", "pool_id", "${timeCol}") DO UPDATE SET
      "close_sqrt_x96" = EXCLUDED."close_sqrt_x96",
      "high_sqrt_x96" = GREATEST(${table}."high_sqrt_x96", EXCLUDED."high_sqrt_x96"),
      "low_sqrt_x96" = LEAST(${table}."low_sqrt_x96", EXCLUDED."low_sqrt_x96"),
      "buy_volume_eth" = ${table}."buy_volume_eth" + EXCLUDED."buy_volume_eth",
      "sell_volume_eth" = ${table}."sell_volume_eth" + EXCLUDED."sell_volume_eth",
      "buy_volume_tokens" = ${table}."buy_volume_tokens" + EXCLUDED."buy_volume_tokens",
      "sell_volume_tokens" = ${table}."sell_volume_tokens" + EXCLUDED."sell_volume_tokens",
      swap_count = ${table}.swap_count + 1,
      "updated_at" = now()`);
}

/** Day-grain revenue deltas for a pool + the protocol-wide day rollup. */
export async function dayRevenueDelta(
  tx: Prisma.TransactionClient,
  chainId: number,
  poolId: string,
  day: Date,
  creatorAdd: bigint,
  protocolAdd: bigint,
): Promise<void> {
  if (creatorAdd === 0n && protocolAdd === 0n) return;
  await tx.$executeRawUnsafe(`
    INSERT INTO pool_day_stats
      ("chain_id", "pool_id", day, "open_sqrt_x96", "close_sqrt_x96", "high_sqrt_x96", "low_sqrt_x96",
       "creator_revenue_eth", "protocol_revenue_eth", "updated_at")
    VALUES (${chainId}, '${poolId}', date_trunc('day', '${day.toISOString()}'::timestamptz), 0, 0, 0, 0, ${creatorAdd}, ${protocolAdd}, now())
    ON CONFLICT ("chain_id", "pool_id", day) DO UPDATE SET
      "creator_revenue_eth" = pool_day_stats."creator_revenue_eth" + ${creatorAdd},
      "protocol_revenue_eth" = pool_day_stats."protocol_revenue_eth" + ${protocolAdd},
      "updated_at" = now()`);
  await protocolDayCounter(
    tx,
    chainId,
    day,
    creatorAdd > 0n ? 'creator_revenue_eth' : 'protocol_revenue_eth',
    creatorAdd > 0n ? creatorAdd : protocolAdd,
  );
}

export async function protocolDayCounter(
  tx: Prisma.TransactionClient,
  chainId: number,
  day: Date,
  column:
    | 'swap_count'
    | 'graduation_count'
    | 'launch_count'
    | 'creator_revenue_eth'
    | 'protocol_revenue_eth'
    | 'harvest_fees_eth',
  add: bigint | number = 1,
): Promise<void> {
  await tx.$executeRawUnsafe(`
    INSERT INTO protocol_day_stats ("chain_id", day, "${column}", "updated_at")
    VALUES (${chainId}, date_trunc('day', '${day.toISOString()}'::timestamptz), ${big(add)}, now())
    ON CONFLICT ("chain_id", day) DO UPDATE SET
      "${column}" = protocol_day_stats."${column}" + ${big(add)}, "updated_at" = now()`);
}

export async function protocolDayVolume(
  tx: Prisma.TransactionClient,
  chainId: number,
  day: Date,
  buyEth: bigint,
  sellEth: bigint,
  swapCount: bigint,
): Promise<void> {
  await tx.$executeRawUnsafe(`
    INSERT INTO protocol_day_stats ("chain_id", day, "buy_volume_eth", "sell_volume_eth", swap_count, "updated_at")
    VALUES (${chainId}, date_trunc('day', '${day.toISOString()}'::timestamptz), ${buyEth}, ${sellEth}, ${swapCount}, now())
    ON CONFLICT ("chain_id", day) DO UPDATE SET
      "buy_volume_eth" = protocol_day_stats."buy_volume_eth" + ${buyEth},
      "sell_volume_eth" = protocol_day_stats."sell_volume_eth" + ${sellEth},
      swap_count = protocol_day_stats.swap_count + ${swapCount},
      "updated_at" = now()`);
}

export async function protocolStatsAdd(
  tx: Prisma.TransactionClient,
  chainId: number,
  add: Record<string, bigint>,
): Promise<void> {
  const names = Object.keys(add)
    .map((k) => `"${k}"`)
    .join(', ');
  const values = Object.values(add).map(big).join(', ');
  const sets = Object.entries(add)
    .map(([k, v]) => `"${k}" = protocol_stats."${k}" + ${big(v)}`)
    .join(', ');
  await tx.$executeRawUnsafe(`
    INSERT INTO protocol_stats ("chain_id", ${names}, "updated_at")
    VALUES (${chainId}, ${values}, now())
    ON CONFLICT ("chain_id") DO UPDATE SET ${sets}, "updated_at" = now()`);
}

export async function potDelta(
  tx: Prisma.TransactionClient,
  chainId: number,
  poolId: string,
  balanceAdd: bigint,
  fundedAdd: bigint,
  serviceFeeAdd: bigint,
): Promise<void> {
  await tx.$executeRawUnsafe(`
    INSERT INTO pots ("chain_id", "pool_id", balance, "funded_total", "service_fee_total", "updated_at")
    VALUES (${chainId}, '${poolId}', ${balanceAdd}, ${fundedAdd}, ${serviceFeeAdd}, now())
    ON CONFLICT ("chain_id", "pool_id") DO UPDATE SET
      balance = pots.balance + ${balanceAdd},
      "funded_total" = pots."funded_total" + ${fundedAdd},
      "service_fee_total" = pots."service_fee_total" + ${serviceFeeAdd},
      "updated_at" = now()`);
}
