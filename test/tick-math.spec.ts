import {
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
} from '../src/protocol/tick-math';

describe('TickMath port (v4-core exact)', () => {
  it('reproduces the boundary sqrt prices exactly', () => {
    expect(getSqrtPriceAtTick(-887272)).toBe(MIN_SQRT_PRICE);
    expect(getSqrtPriceAtTick(887272)).toBe(MAX_SQRT_PRICE);
  });

  it('produces 2^96 at tick 0 (price 1)', () => {
    expect(getSqrtPriceAtTick(0)).toBe(1n << 96n);
  });

  it.each([60, -60, -887272, 123456, -123456, 1, -1, 2235, 6931, 887271])(
    'roundtrips tick %i through getTickAtSqrtPrice',
    (tick) => {
      expect(getTickAtSqrtPrice(getSqrtPriceAtTick(tick))).toBe(tick);
    },
  );

  it('returns the greatest tick with sqrt(tick) <= input', () => {
    expect(getTickAtSqrtPrice(MIN_SQRT_PRICE)).toBe(-887272);
    expect(getTickAtSqrtPrice(MAX_SQRT_PRICE - 1n)).toBe(887271);
  });

  it('rejects out-of-range sqrt prices', () => {
    expect(() => getTickAtSqrtPrice(MIN_SQRT_PRICE - 1n)).toThrow();
    expect(() => getTickAtSqrtPrice(MAX_SQRT_PRICE)).toThrow();
  });

  it('rejects out-of-range ticks', () => {
    expect(() => getSqrtPriceAtTick(887273)).toThrow();
    expect(() => getSqrtPriceAtTick(-887273)).toThrow();
  });
});
