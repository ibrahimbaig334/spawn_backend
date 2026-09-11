/**
 * Exact port of Uniswap v4 TickMath (v4-core, pinned 5f00c84) to TypeScript bigint math.
 *
 * getSqrtPriceAtTick reproduces the Q128.128 ratio-table algorithm bit-for-bit,
 * including the final rounding-up division, so indexer geometry matches on-chain
 * state exactly. getTickAtSqrtPrice reproduces the log-refinement algorithm with its
 * tickLow/tickHi correction.
 */

import { MIN_TICK, MAX_TICK, MIN_SQRT_PRICE, MAX_SQRT_PRICE } from './protocol-constants';

const UINT32_MAX = 0xffffffffn;
const MAX_UINT256 = (1n << 256n) - 1n;

function mostSignificantBit(x: bigint): number {
  if (x === 0n) throw new Error('msb of zero');
  let msb = 0;
  if (x >= 1n << 128n) {
    msb += 128;
    x >>= 128n;
  }
  if (x >= 1n << 64n) {
    msb += 64;
    x >>= 64n;
  }
  if (x >= 1n << 32n) {
    msb += 32;
    x >>= 32n;
  }
  if (x >= 1n << 16n) {
    msb += 16;
    x >>= 16n;
  }
  if (x >= 1n << 8n) {
    msb += 8;
    x >>= 8n;
  }
  if (x >= 1n << 4n) {
    msb += 4;
    x >>= 4n;
  }
  if (x >= 1n << 2n) {
    msb += 2;
    x >>= 2n;
  }
  if (x >= 1n << 1n) {
    msb += 1;
  }
  return msb;
}

/** sqrt(1.0001^tick) * 2^96 as Q64.96; exact port of TickMath.getSqrtPriceAtTick. */
export function getSqrtPriceAtTick(tick: number): bigint {
  const absTick = BigInt(Math.abs(tick));
  if (absTick > BigInt(MAX_TICK)) {
    throw new Error(`Tick ${tick} out of range`);
  }

  let price: bigint;
  if (absTick & 0x1n) price = 0xfffcb933bd6fad37aa2d162d1a594001n;
  else price = 1n << 128n;

  if (absTick & 0x2n) price = (price * 0xfff97272373d413259a46990580e213an) >> 128n;
  if (absTick & 0x4n) price = (price * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if (absTick & 0x8n) price = (price * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if (absTick & 0x10n) price = (price * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if (absTick & 0x20n) price = (price * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if (absTick & 0x40n) price = (price * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if (absTick & 0x80n) price = (price * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if (absTick & 0x100n) price = (price * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if (absTick & 0x200n) price = (price * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if (absTick & 0x400n) price = (price * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if (absTick & 0x800n) price = (price * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if (absTick & 0x1000n) price = (price * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if (absTick & 0x2000n) price = (price * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if (absTick & 0x4000n) price = (price * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if (absTick & 0x8000n) price = (price * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if (absTick & 0x10000n) price = (price * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if (absTick & 0x20000n) price = (price * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if (absTick & 0x40000n) price = (price * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if (absTick & 0x80000n) price = (price * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) price = MAX_UINT256 / price;

  // Divide by 2^32 rounding up (Q128.128 -> Q128.96). Per v4 the addition cannot
  // overflow (price fits in 192 bits after the inversion) and the result fits 160 bits.
  return (price + UINT32_MAX) >> 32n;
}

/** Greatest tick with getSqrtPriceAtTick(tick) <= sqrtPriceX96; exact port of TickMath.getTickAtSqrtPrice. */
export function getTickAtSqrtPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) {
    throw new Error('SqrtPrice out of range');
  }

  const price = sqrtPriceX96 << 32n;

  let r = price;
  const msb = mostSignificantBit(r);

  if (msb >= 128) r = price >> BigInt(msb - 127);
  else r = price << BigInt(127 - msb);

  let log2 = BigInt(msb - 128) << 64n;

  for (let shift = 63n; shift >= 0n; shift--) {
    r = (r * r) >> 127n;
    const f = r >> 128n;
    log2 = log2 | (f << shift);
    r = r >> f;
  }

  const logSqrt10001 = log2 * 255738958999603826347141n;

  const tickLow = Number((logSqrt10001 - 3402992956809132418596140100660247210n) >> 128n);
  const tickHi = Number((logSqrt10001 + 291339464771989622907027621153398088495n) >> 128n);

  return tickLow === tickHi
    ? tickLow
    : getSqrtPriceAtTick(tickHi) <= sqrtPriceX96
      ? tickHi
      : tickLow;
}

export { MIN_TICK, MAX_TICK, MIN_SQRT_PRICE, MAX_SQRT_PRICE };
