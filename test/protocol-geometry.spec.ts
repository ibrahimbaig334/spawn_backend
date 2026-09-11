import {
  toLevel,
  toTick,
  levelRangeToTicks,
  bandLevels,
  perBandInventory,
  sizeInventory,
  divToDecimalString,
  fdvEthWeiAtLevel,
  fdvEthWeiAtSqrtPrice,
  sqrtPriceAtLevel,
} from '../src/protocol/protocol-math';
import { MAX_LEVEL } from '../src/protocol/protocol-constants';

describe('orientation', () => {
  it('level = -tick round trips', () => {
    expect(toLevel(1234)).toBe(-1234);
    expect(toTick(-1234)).toBe(1234);
    expect(toLevel(toTick(7))).toBe(7);
  });

  it('level range to ticks swaps the bounds', () => {
    const { tickLower, tickUpper } = levelRangeToTicks(100, 200);
    expect(tickLower).toBe(-200);
    expect(tickUpper).toBe(-100);
    expect(() => levelRangeToTicks(200, 200)).toThrow();
  });
});

describe('ladder geometry (LadderLib port)', () => {
  it('band i sits (i+1) spacings above graduation with a 447-level wall', () => {
    const graduation = -50_000;
    const band0 = bandLevels(graduation, 2235, 447, 0);
    expect(band0.levelLower).toBe(graduation + 2235);
    expect(band0.levelUpper).toBe(band0.levelLower + 447);
    const band9 = bandLevels(graduation, 2235, 447, 9);
    expect(band9.levelLower).toBe(graduation + 10 * 2235);
  });

  it('reports exists=false past MAX_LEVEL', () => {
    const last = bandLevels(MAX_LEVEL - 10_000, 2235, 447, 5);
    expect(last.exists).toBe(false);
  });

  it('per-band inventory divides the ladder supply evenly', () => {
    const supply = 1_000_000n * 10n ** 18n;
    const perBand = perBandInventory(supply, 650_000_000_000_000_000n, 30); // 0.65e18 WAD share
    expect(perBand).toBe((supply * 65n) / 100n / 30n);
  });

  it('sizeInventory caps at perBand * capMultiple and carries the rest', () => {
    const { amount, carried } = sizeInventory(500n, 100n, 2);
    expect(amount).toBe(200n);
    expect(carried).toBe(300n);
    const under = sizeInventory(150n, 100n, 2);
    expect(under.amount).toBe(150n);
    expect(under.carried).toBe(0n);
  });
});

describe('fdv math', () => {
  it('computes fdv identically from level or from the exact sqrt price', () => {
    const supply = 1_000_000n * 10n ** 18n;
    const level = -50_000;
    const fromLevel = fdvEthWeiAtLevel(supply, level);
    const fromSqrt = fdvEthWeiAtSqrtPrice(supply, sqrtPriceAtLevel(level));
    expect(fromLevel).toBe(fromSqrt);
  });

  it('is monotonically increasing in level', () => {
    const supply = 1_000_000n * 10n ** 18n;
    const low = fdvEthWeiAtLevel(supply, -80_000);
    const high = fdvEthWeiAtLevel(supply, -70_000);
    expect(high).toBeGreaterThan(low);
  });
});

describe('divToDecimalString', () => {
  it('formats exact 18-decimal fractions', () => {
    expect(divToDecimalString(125n, 1_000_000n, 18)).toBe('0.000125000000000000');
    expect(divToDecimalString(1n, 1n, 2)).toBe('1.00');
    expect(divToDecimalString(7n, 2n, 1)).toBe('3.5');
  });
});
