export const CACHE_TTL_SECONDS = {
  trades: 2,
  tokenDetail: 5,
  portfolio: 5,
  tokenList: 10,
  featured: 10,
  milestones: 10,
  candles: 15,
  likeStatus: 15,
  comments: 30,
  profile: 60,
  creatorTokens: 60,
} as const;

export function subtractiveJitter(ttlSeconds: number, random = Math.random): number {
  const factor = 0.9 + random() * 0.1;
  return Math.max(1, Math.floor(ttlSeconds * factor));
}
