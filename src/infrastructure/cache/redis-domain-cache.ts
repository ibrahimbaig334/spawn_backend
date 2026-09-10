import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { serializeNumeric } from '../../common/serialization/numeric.serializer';
import { subtractiveJitter } from './cache-ttl';
import type { CacheSetOptions, DomainCachePort } from './domain-cache.port';

const APPLY_GENERATION = `
local current = redis.call('GET', KEYS[1])
local incoming = ARGV[1]
if not current or #incoming > #current or (#incoming == #current and incoming > current) then
  redis.call('SET', KEYS[1], incoming)
  return incoming
end
return current
`;

@Injectable()
export class RedisDomainCache implements DomainCachePort, OnModuleDestroy {
  private readonly redis: Redis;

  constructor() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error('REDIS_URL is required');
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.redis.get(key);
      return value === null ? null : (JSON.parse(value) as T);
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, options: CacheSetOptions): Promise<void> {
    try {
      await this.redis.set(
        key,
        JSON.stringify(serializeNumeric(value)),
        'EX',
        subtractiveJitter(options.ttlSeconds),
      );
    } catch {
      return;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch {
      return;
    }
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async getGeneration(domain: string): Promise<bigint> {
    try {
      return BigInt((await this.redis.get(this.generationKey(domain))) ?? '0');
    } catch {
      return 0n;
    }
  }

  async applyGeneration(domain: string, generation: bigint): Promise<void> {
    try {
      await this.applyGenerationStrict(domain, generation);
    } catch {
      return;
    }
  }

  async applyGenerationStrict(domain: string, generation: bigint): Promise<void> {
    await this.redis.eval(APPLY_GENERATION, 1, this.generationKey(domain), generation.toString());
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit();
      return;
    }
    this.redis.disconnect();
  }

  private generationKey(domain: string): string {
    return `generation:${domain}`;
  }
}
