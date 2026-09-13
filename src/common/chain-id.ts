/**
 * Query-string chain ids arrive as strings whenever a controller uses an
 * inline `@Query()` type (which skips class-transformer coercion). Coerce
 * defensively and fall back to DEFAULT_CHAIN_ID on anything unusable.
 */
export function resolveChainId(value: unknown): number {
  const fallback = Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
  const parsed =
    value === undefined || value === null || value === '' ? fallback : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
