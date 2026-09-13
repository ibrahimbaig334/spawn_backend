import { Prisma } from '@prisma/client';

/**
 * Conversions between EVM bigint values and Prisma Decimal columns. Decimal(78,0)
 * columns hold arbitrary-precision integers; strings are the exact round-trip form.
 */

export function bigToDecimal(value: bigint): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

export function decimalToBig(value: { toFixed(): string }): bigint {
  const fixed = value.toFixed();
  if (!/^-?\d+$/.test(fixed)) throw new Error(`non-integer decimal: ${fixed}`);
  return BigInt(fixed);
}

/** WAD-scaled fixed point (18 decimals) as Decimal(38,18). */
export function wadToDecimal(value: bigint): Prisma.Decimal {
  return new Prisma.Decimal(value.toString()).div(new Prisma.Decimal(10).pow(18));
}
