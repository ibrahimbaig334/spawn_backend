export interface RateLimitPolicy {
  ipLimit: number;
  walletLimit: number;
  windowSeconds: number;
}

export const RATE_LIMIT_POLICIES = {
  general: { ipLimit: 60, walletLimit: 30, windowSeconds: 60 },
  tokenCreate: { ipLimit: 5, walletLimit: 3, windowSeconds: 3_600 },
  comment: { ipLimit: 20, walletLimit: 10, windowSeconds: 60 },
  commentLike: { ipLimit: 120, walletLimit: 60, windowSeconds: 60 },
  profileUpdate: { ipLimit: 20, walletLimit: 10, windowSeconds: 3_600 },
} as const satisfies Record<string, RateLimitPolicy>;
