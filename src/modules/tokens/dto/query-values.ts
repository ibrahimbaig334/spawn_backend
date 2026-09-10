import { Timeframe } from '@prisma/client';

export const API_TIMEFRAMES = ['1h', '24h', '7d', '30d', 'all'] as const;
export type ApiTimeframe = (typeof API_TIMEFRAMES)[number];

const PRISMA_TIMEFRAMES: Record<ApiTimeframe, Timeframe> = {
  '1h': Timeframe.H1,
  '24h': Timeframe.H24,
  '7d': Timeframe.D7,
  '30d': Timeframe.D30,
  all: Timeframe.ALL,
};

const TIMEFRAME_MILLISECONDS: Partial<Record<ApiTimeframe, number>> = {
  '1h': 60 * 60 * 1_000,
  '24h': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
  '30d': 30 * 24 * 60 * 60 * 1_000,
};

export function toPrismaTimeframe(value: ApiTimeframe): Timeframe {
  return PRISMA_TIMEFRAMES[value];
}

export function timeframeStart(value: ApiTimeframe, now = new Date()): Date | undefined {
  const milliseconds = TIMEFRAME_MILLISECONDS[value];
  return milliseconds === undefined ? undefined : new Date(now.getTime() - milliseconds);
}

export function normalizeOptionalLowercase(value: unknown): unknown {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

export function parseOptionalBoolean(value: unknown): unknown {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
}
