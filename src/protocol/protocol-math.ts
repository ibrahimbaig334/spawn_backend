/**
 * Protocol orientation, price math, launch signature, and curve/ladder geometry.
 */

import { keccak256, encodeAbiParameters, toHex, concatHex, type Address, type Hex } from 'viem';
import {
  MIN_LEVEL,
  MAX_LEVEL,
  MIN_TICK,
  MAX_TICK,
  EIP712_DOMAIN,
  LAUNCH_CONFIG_TYPEHASH_STRING,
} from './protocol-constants';
import { getSqrtPriceAtTick, getTickAtSqrtPrice } from './tick-math';

/**
 * Level-space orientation and derived price math (exact, wei-denominated).
 *
 * Native ETH is currency0, the launch token is always currency1; raw pool price is
 * token-wei per ETH-wei and `level = -tick` rises as the token pumps. All display
 * math runs in level space; convert exactly once at the pool boundary.
 *
 * Price identities (Q64.96 sqrt prices from the exact v4 tick table):
 *   rawPrice            = (sqrtP / 2^96)^2   = token-wei per ETH-wei = 1.0001^tick
 *   ethPerToken (rational) = 1.0001^level    = 2^192 / sqrtP^2
 *   fdvEthWei           = totalSupplyWei * 2^192 / sqrtP^2
 */

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const UINT128_MAX = 0xffffffffffffffffffffffffffffffffn;
const UINT256_MAX = (1n << 256n) - 1n;

export function toLevel(tick: number): number {
  return -tick;
}

export function toTick(level: number): number {
  return -level;
}

export function isValidLevel(level: number): boolean {
  return level >= MIN_LEVEL && level <= MAX_LEVEL;
}

export function isValidTick(tick: number): boolean {
  return tick >= MIN_TICK && tick <= MAX_TICK;
}

/**
 * levelLower/levelUpper (ascending price) -> tickLower/tickUpper (bounds swap).
 * Port of Orientation.levelRangeToTicks; throws when not strictly ascending.
 */
export function levelRangeToTicks(
  levelLower: number,
  levelUpper: number,
): { tickLower: number; tickUpper: number } {
  if (levelLower >= levelUpper) {
    throw new Error(`Level range not ascending: ${levelLower} >= ${levelUpper}`);
  }
  return { tickLower: toTick(levelUpper), tickUpper: toTick(levelLower) };
}

/** Inverse of levelRangeToTicks. */
export function tickRangeToLevels(
  tickLower: number,
  tickUpper: number,
): { levelLower: number; levelUpper: number } {
  if (tickLower >= tickUpper) {
    throw new Error(`Tick range not ascending: ${tickLower} >= ${tickUpper}`);
  }
  return { levelLower: toLevel(tickUpper), levelUpper: toLevel(tickLower) };
}

/** Sqrt price (Q64.96) at a level — the exact v4 table value at the level's tick. */
export function sqrtPriceAtLevel(level: number): bigint {
  return getSqrtPriceAtTick(toTick(level));
}

/** Level at a sqrt price (Q64.96). */
export function levelAtSqrtPrice(sqrtPriceX96: bigint): number {
  return toLevel(getTickAtSqrtPrice(sqrtPriceX96));
}

/** Floor sqrt for non-negative bigints (OpenZeppelin Math.sqrt semantics). */
export function isqrt(x: bigint): bigint {
  if (x < 0n) throw new Error('isqrt of negative');
  if (x < 2n) return x;
  let guess = 1n << BigInt(Math.ceil(x.toString(2).length / 2));
  while (true) {
    const next = (guess + x / guess) >> 1n;
    if (next >= guess) return guess; // converged: guess is floor(sqrt(x))
    guess = next;
  }
}

/** floor(a*b/d) with full 512-bit intermediate. */
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b) / denominator;
}

/** ceil(a*b/d). */
export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const product = a * b;
  const result = product / denominator;
  if (product % denominator !== 0n) return result + 1n;
  return result;
}

/** ceil(a/d). */
export function divRoundingUp(a: bigint, denominator: bigint): bigint {
  const result = a / denominator;
  if (a % denominator !== 0n) return result + 1n;
  return result;
}

/**
 * ETH-wei per token-wei at a level, as an exact rational (numerator/denominator).
 * ethPerToken = 1.0001^level = 2^192 / sqrtP^2.
 */
export function ethPerTokenRational(level: number): { numerator: bigint; denominator: bigint } {
  const sqrtP = sqrtPriceAtLevel(level);
  return { numerator: Q192, denominator: sqrtP * sqrtP };
}

/** FDV in ETH-wei (floor): totalSupplyWei * 2^192 / sqrtP^2. */
export function fdvEthWeiAtLevel(totalSupplyWei: bigint, level: number): bigint {
  const sqrtP = sqrtPriceAtLevel(level);
  return (totalSupplyWei * Q192) / (sqrtP * sqrtP);
}

/** FDV in ETH-wei (floor) from a raw pool sqrt price (e.g. live slot0). */
export function fdvEthWeiAtSqrtPrice(totalSupplyWei: bigint, sqrtPriceX96: bigint): bigint {
  return (totalSupplyWei * Q192) / (sqrtPriceX96 * sqrtPriceX96);
}

/** Raw pool price (token-wei per ETH-wei) at a level, floored. */
export function rawPriceAtLevel(level: number): bigint {
  const sqrtP = sqrtPriceAtLevel(level);
  return (sqrtP * sqrtP) / Q192;
}

/** Formats floor(numerator/denominator) as a decimal string with `decimals` fractional digits. */
export function divToDecimalString(
  numerator: bigint,
  denominator: bigint,
  decimals: number,
): string {
  if (decimals < 0) throw new Error('negative decimals');
  const scale = 10n ** BigInt(decimals);
  const scaled = (numerator * scale) / denominator;
  const whole = scaled / scale;
  const fraction = scaled % scale;
  return `${whole.toString()}.${fraction.toString().padStart(decimals, '0')}`;
}

/**
 * Human price of one whole token in ETH, as a decimal string.
 * value(ETH-wei) of 10^decimals token-wei = 10^decimals * 2^192 / sqrtP^2;
 * price(ETH) = value / 1e18.
 */
export function tokenPriceEthString(level: number, decimals: number): string {
  const sqrtP = sqrtPriceAtLevel(level);
  const numerator = 10n ** BigInt(decimals) * Q192 * 10n ** 18n;
  const denominator = sqrtP * sqrtP * 10n ** 18n;
  return divToDecimalString(numerator, denominator, 18);
}

// ---------------------------------------------------------------------------
// Curve geometry (CurveLib port)
// ---------------------------------------------------------------------------

/**
 * Opening level for a supply: log_1.0001(openingFdvWei / totalSupplyWei).
 * Port of CurveLib.openingLevel: priceX192 = totalSupply * 2^192 / fdv (exact mulDiv),
 * sqrtPriceX96 = floor sqrt, level = -getTickAtSqrtPrice(uint160(sqrt)).
 */
export function openingLevel(totalSupplyWei: bigint, openingFdvWei: bigint): number {
  const priceX192 = mulDiv(totalSupplyWei, Q192, openingFdvWei);
  const sqrtPriceX96 = isqrt(priceX192);
  if (
    sqrtPriceX96 < 4_295_128_739n ||
    sqrtPriceX96 >= 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n
  ) {
    throw new Error(`Opening level out of range for supply ${totalSupplyWei}`);
  }
  const level = toLevel(getTickAtSqrtPrice(sqrtPriceX96));
  if (!isValidLevel(level)) throw new Error(`Opening level ${level} invalid`);
  return level;
}

/** Far level: opening + span, range-checked (CurveLib.farLevel). */
export function farLevel(opening: number, spanLevels: number): number {
  const far = opening + spanLevels;
  if (far > MAX_LEVEL) throw new Error(`Far level ${far} out of range`);
  return far;
}

/** Curve position i's start level (CurveLib.positionStart). */
export function curvePositionStart(
  opening: number,
  far: number,
  positions: number,
  index: number,
): number {
  const span = far - opening;
  return opening + Math.trunc((span * index) / positions);
}

/** Curve position i's token amount (CurveLib.positionAmount): equal shares, last absorbs remainder. */
export function curvePositionAmount(curveSupply: bigint, positions: number, index: number): bigint {
  const each = curveSupply / BigInt(positions);
  if (index + 1 === positions) return curveSupply - each * BigInt(positions - 1);
  return each;
}

/** Liquidity of curve position i (CurveLib.positionLiquidity): L = amount1 * Q96 / dSqrtPrice, uint128-clamped. */
export function curvePositionLiquidity(
  opening: number,
  far: number,
  positions: number,
  curveSupply: bigint,
  index: number,
): bigint {
  const start = curvePositionStart(opening, far, positions, index);
  if (start >= far) return 0n;
  const { tickLower, tickUpper } = levelRangeToTicks(start, far);
  const denominator = getSqrtPriceAtTick(tickUpper) - getSqrtPriceAtTick(tickLower);
  if (denominator === 0n) return 0n;
  const liquidity = mulDiv(curvePositionAmount(curveSupply, positions, index), Q96, denominator);
  return liquidity > UINT128_MAX ? UINT128_MAX : liquidity;
}

// ---------------------------------------------------------------------------
// Ladder geometry (LadderLib port)
// ---------------------------------------------------------------------------

/**
 * Band i's level bounds — decaying ladder schedule (LadderLib.bandLevels closed form).
 * Band i+1 starts max(levelSpacing, firstStep - decay*i) levels above band i.
 */
export function bandLevels(
  graduationLevel: number,
  firstStepLevels: number,
  stepDecayLevels: number,
  levelSpacing: number,
  widthLevels: number,
  index: number,
): { levelLower: number; levelUpper: number; exists: boolean } {
  const m = BigInt(index) + 1n;
  const first = BigInt(firstStepLevels);
  const decay = BigInt(stepDecayLevels);
  const spacing = BigInt(levelSpacing);
  const k = (first - spacing) / decay;
  let offset: bigint;
  if (m <= k + 1n) {
    offset = first * m - (decay * m * (m - 1n)) / 2n;
  } else {
    offset = first * (k + 1n) - (decay * k * (k + 1n)) / 2n + (m - k - 1n) * spacing;
  }
  const lower = BigInt(graduationLevel) + offset;
  const upper = lower + BigInt(widthLevels);
  if (upper > BigInt(MAX_LEVEL)) return { levelLower: 0, levelUpper: 0, exists: false };
  return { levelLower: Number(lower), levelUpper: Number(upper), exists: true };
}

/** Per-core-band inventory (LadderLib.perBandInventory). */
export function perBandInventory(
  totalSupply: bigint,
  ladderSupplyShareWad: bigint,
  coreBandCount: number,
): bigint {
  if (coreBandCount === 0) return 0n;
  return ladderSupply(totalSupply, ladderSupplyShareWad) / BigInt(coreBandCount);
}

/** Ladder total allocation (LadderLib.ladderSupply). */
export function ladderSupply(totalSupply: bigint, ladderSupplyShareWad: bigint): bigint {
  return mulDiv(totalSupply, ladderSupplyShareWad, 10n ** 18n);
}

/** Band inventory split (LadderLib.sizeInventory): cap at perBand * capMultiple, rest carries. */
export function sizeInventory(
  available: bigint,
  perBand: bigint,
  capMultiple: number,
): { amount: bigint; carried: bigint } {
  const cap = saturatingMul(perBand, BigInt(capMultiple));
  if (available > cap) return { amount: cap, carried: available - cap };
  return { amount: available, carried: 0n };
}

function saturatingMul(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  const product = a * b;
  if (product / a !== b) return UINT256_MAX;
  return product;
}

// ---------------------------------------------------------------------------
// v4 swap math (SqrtPriceMath / SwapMath ports used by quotes)
// ---------------------------------------------------------------------------

/** v4 SqrtPriceMath.getAmount0Delta (unsigned, roundUp configurable). */
export function amount0Delta(
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  let sqrtA = sqrtPriceAX96;
  let sqrtB = sqrtPriceBX96;
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA === 0n) throw new Error('Invalid price');
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtB - sqrtA;
  if (roundUp) {
    return divRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtB), sqrtA);
  }
  return mulDiv(numerator1, numerator2, sqrtB) / sqrtA;
}

/** v4 SqrtPriceMath.getAmount1Delta (unsigned, roundUp configurable). */
export function amount1Delta(
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const numerator =
    sqrtPriceAX96 > sqrtPriceBX96 ? sqrtPriceAX96 - sqrtPriceBX96 : sqrtPriceBX96 - sqrtPriceAX96;
  const quotient = mulDiv(liquidity, numerator, Q96);
  if (roundUp && (liquidity * numerator) % Q96 !== 0n) return quotient + 1n;
  return quotient;
}

/** v4 SqrtPriceMath.getNextSqrtPriceFromAmount1RoundingDown (subtract branch: price decreasing in sqrt). */
export function nextSqrtFromAmount1Out(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  amount1Out: bigint,
): bigint {
  const quotient = divRoundingUp(amount1Out << 96n, liquidity);
  if (sqrtPriceX96 <= quotient) throw new Error('Not enough liquidity');
  return sqrtPriceX96 - quotient;
}

// ---------------------------------------------------------------------------
// EIP-712 launch signature (LaunchSignature.sol port)
// ---------------------------------------------------------------------------

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);

const DOMAIN_NAME_HASH = keccak256(toHex(EIP712_DOMAIN.name));
const DOMAIN_VERSION_HASH = keccak256(toHex(EIP712_DOMAIN.version));

const LAUNCH_CONFIG_TYPEHASH = keccak256(toHex(LAUNCH_CONFIG_TYPEHASH_STRING));

export type LaunchConfigInput = {
  creator: Address;
  name: string;
  symbol: string;
  uri: string;
  totalSupply: bigint;
  devBuyShareWad: bigint;
  payoutPlan: bigint;
  deadline: bigint;
};

function keccakUtf8(value: string): Hex {
  return keccak256(toHex(value));
}

/** LaunchSignature.configHash — identity excluding the deadline (CREATE2 salt input). */
export function launchConfigHash(config: LaunchConfigInput): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint64' },
        { type: 'uint256' },
      ],
      [
        config.creator,
        keccakUtf8(config.name),
        keccakUtf8(config.symbol),
        keccakUtf8(config.uri),
        config.totalSupply,
        config.devBuyShareWad,
        config.payoutPlan,
      ],
    ),
  );
}

/** LaunchSignature.tokenSalt — CREATE2 salt = keccak256(abi.encode(configHash, creator)). */
export function launchTokenSalt(configHash: Hex, creator: Address): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], [configHash, creator]),
  );
}

/** LaunchSignature.digest — the EIP-712 digest a creator signs over the full config. */
export function launchDigest(
  config: LaunchConfigInput,
  hookAddress: Address,
  chainId: number,
): Hex {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [EIP712_DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, BigInt(chainId), hookAddress],
    ),
  );

  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint64' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [
        LAUNCH_CONFIG_TYPEHASH,
        config.creator,
        keccakUtf8(config.name),
        keccakUtf8(config.symbol),
        keccakUtf8(config.uri),
        config.totalSupply,
        config.devBuyShareWad,
        config.payoutPlan,
        config.deadline,
      ],
    ),
  );

  // EIP-712 digest: keccak256("\x19\x01" || domainSeparator || structHash) — byte concat.
  return keccak256(concatHex(['0x1901', domainSeparator, structHash]));
}

// ---------------------------------------------------------------------------
// Dev-buy pre-launch quote (integration guide section 4.5)
// ---------------------------------------------------------------------------

export type DevBuyQuote = {
  /** Exact token amount the creator receives: totalSupply * devBuyShareWad / WAD. */
  tokensOut: bigint;
  /** ETH (incl. the 1% fee) the buy consumes on the fresh curve, wei. Attach with headroom. */
  ethCost: bigint;
  /** Level the buy ends at (>= opening; the curve's exact-input semantics may round up a tick). */
  endLevel: number;
  endSqrtPriceX96: bigint;
};

/**
 * Pre-launch dev-buy quote: pure math walking the nested bonding curve exactly as
 * the hook's simulation would (positions deploy JIT as the buy's path approaches).
 *
 * The curve nests: position i spans [start(i), far]; liquidity is cumulative as the
 * buy's path crosses each position's start level. The buy is exact-out over the
 * fixed token amount; at each boundary segment ETH cost is
 * getAmount0Delta(roundUp) plus the 1% fee on the input side, matching v4's
 * computeSwapStep for exact-output swaps.
 */
export function devBuyQuote(params: {
  totalSupplyWei: bigint;
  devBuyShareWad: bigint;
  openingLevel: number;
  farLevel: number;
  curvePositions: number;
  curveSupply: bigint;
  tradingFeeHundredthsBip: number;
}): DevBuyQuote {
  const {
    totalSupplyWei,
    devBuyShareWad,
    openingLevel: opening,
    farLevel: far,
    curvePositions: positions,
    curveSupply,
    tradingFeeHundredthsBip: feePips,
  } = params;
  const tokensOut = mulDiv(totalSupplyWei, devBuyShareWad, 10n ** 18n);
  const startSqrt = sqrtPriceAtLevel(opening);
  if (tokensOut === 0n) {
    return { tokensOut: 0n, ethCost: 0n, endLevel: opening, endSqrtPriceX96: startSqrt };
  }

  // Boundaries: sqrt prices at each position's start level, descending as level rises.
  // Positions 1..n-1 become active crossing these; position 0 is active from the start.
  const boundaries: { sqrtPrice: bigint; liquidity: bigint }[] = [];
  for (let i = 1; i < positions; i += 1) {
    const start = curvePositionStart(opening, far, positions, i);
    if (start >= far) break;
    boundaries.push({
      sqrtPrice: sqrtPriceAtLevel(start),
      liquidity: curvePositionLiquidity(opening, far, positions, curveSupply, i),
    });
  }
  const farSqrt = sqrtPriceAtLevel(far);

  let activeLiquidity = curvePositionLiquidity(opening, far, positions, curveSupply, 0);
  if (activeLiquidity === 0n) throw new Error('position 0 has zero liquidity');
  let currentSqrt = startSqrt;
  let remaining = tokensOut;
  let ethCost = 0n;
  let boundaryIndex = 0;

  while (true) {
    // Next boundary: the next position start, or the far level.
    let targetSqrt: bigint;
    let targetIsBoundary = false;
    while (
      boundaryIndex < boundaries.length &&
      boundaries[boundaryIndex]!.sqrtPrice >= currentSqrt
    ) {
      boundaryIndex += 1; // skip boundaries at/above current price
    }
    if (boundaryIndex < boundaries.length) {
      targetSqrt = boundaries[boundaryIndex]!.sqrtPrice;
      targetIsBoundary = true;
    } else {
      targetSqrt = farSqrt;
    }
    if (activeLiquidity === 0n) throw new Error('dev buy exhausted curve liquidity');

    // Token out available until the target at current liquidity (round down).
    const outToTarget = amount1Delta(currentSqrt, targetSqrt, activeLiquidity, false);
    if (remaining < outToTarget) {
      // Finish inside this segment: solve the end price, cost includes fee.
      const endSqrt = nextSqrtFromAmount1Out(currentSqrt, activeLiquidity, remaining);
      const amountIn = amount0Delta(endSqrt, currentSqrt, activeLiquidity, true);
      const fee = mulDivRoundingUp(amountIn, BigInt(feePips), 1_000_000n - BigInt(feePips));
      ethCost += amountIn + fee;
      return { tokensOut, ethCost, endLevel: levelAtSqrtPrice(endSqrt), endSqrtPriceX96: endSqrt };
    }

    // Consume the whole segment up to the target.
    remaining -= outToTarget;
    const amountIn = amount0Delta(targetSqrt, currentSqrt, activeLiquidity, true);
    const fee = mulDivRoundingUp(amountIn, BigInt(feePips), 1_000_000n - BigInt(feePips));
    ethCost += amountIn + fee;
    currentSqrt = targetSqrt;

    if (remaining === 0n) {
      return {
        tokensOut,
        ethCost,
        endLevel: levelAtSqrtPrice(currentSqrt),
        endSqrtPriceX96: currentSqrt,
      };
    }

    if (targetIsBoundary) {
      // A position's start level: its liquidity adds to the active set.
      activeLiquidity += boundaries[boundaryIndex]!.liquidity;
      boundaryIndex += 1;
    } else {
      // Reached the far level with budget remaining: impossible under the 10% cap
      // (curve holds 25% of supply). Guard rather than produce a wrong number.
      throw new Error('dev buy exceeds curve supply');
    }
  }
}
