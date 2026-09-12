import { sqrtPriceAtLevel } from '../../protocol/protocol-math';

/**
 * ETH-per-token conversions on the raw Q64.96 sqrt axis (backend guide §1):
 * token price in ETH (wei per wei) = 2^192 / sqrt^2 — the INVERSE of the raw
 * pool price. Highest ETH price = lowest sqrt.
 */

export function ethPerTokenWei(sqrtPriceX96: bigint): { numerator: bigint; denominator: bigint } {
  return { numerator: 1n << 192n, denominator: sqrtPriceX96 * sqrtPriceX96 };
}

/** Human price of one whole (18-decimal) token in ETH, as an 18-decimal string. */
export function sqrtToEthString(sqrtPriceX96: bigint | { toFixed(): string }): string | null {
  const sqrt = typeof sqrtPriceX96 === 'bigint' ? sqrtPriceX96 : BigInt(sqrtPriceX96.toFixed());
  if (sqrt === 0n) return null;
  const scaled = ((1n << 192n) * 10n ** 18n) / (sqrt * sqrt);
  const whole = scaled / 10n ** 18n;
  const frac = (scaled % 10n ** 18n).toString().padStart(18, '0');
  return `${whole.toString()}.${frac}`;
}

/** FDV in ETH-wei from total supply (wei) + sqrt price. */
export function fdvEthWei(sqrtPriceX96: bigint, totalSupplyWei: bigint): bigint {
  return (totalSupplyWei << 192n) / (sqrtPriceX96 * sqrtPriceX96);
}

/** Level from a raw sqrt price: level = -tick(sqrt). */
export function levelFromSqrtPrice(sqrtPriceX96: bigint): number {
  // Binary search over levels via the exact tick table.
  let lo = -887_272;
  let hi = 887_272;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (sqrtPriceAtLevel(mid) <= sqrtPriceX96) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
