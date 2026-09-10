export interface RateLimitCheck {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

export interface RateLimiterPort {
  check(key: string, limit: number, windowSeconds: number): Promise<RateLimitCheck>;
}
