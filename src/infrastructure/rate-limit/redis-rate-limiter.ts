import { createHmac } from 'node:crypto';
import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import type { RateLimitCheck, RateLimiterPort } from './rate-limiter.port';

const LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return {count, ttl}
`;

@Injectable()
export class RedisRateLimiter implements RateLimiterPort, OnModuleDestroy {
  private readonly redis: Redis;
  private readonly hmacKey: string;

  constructor() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error('REDIS_URL is required');
    this.hmacKey = process.env.RATE_LIMIT_HMAC_KEY ?? 'development-only-rate-limit-key';
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  }

  normalizeBucket(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value.trim().toLowerCase()).digest('hex');
  }

  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitCheck> {
    try {
      const normalizedKey = this.normalizeBucket(key);
      const result = (await this.redis.eval(
        LIMIT_SCRIPT,
        1,
        `rate:${normalizedKey}`,
        String(windowSeconds),
      )) as [number, number];
      const count = Number(result[0]);
      const resetSeconds = Math.max(1, Number(result[1]));
      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(0, limit - count),
        resetSeconds,
      };
    } catch {
      if (process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException({
          code: 'RATE_LIMIT_DEPENDENCY_UNAVAILABLE',
          message: 'Mutation rate limiting is unavailable',
        });
      }
      return { allowed: true, limit, remaining: limit, resetSeconds: windowSeconds };
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit();
      return;
    }
    this.redis.disconnect();
  }
}
