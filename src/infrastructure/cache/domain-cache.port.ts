import { CACHE_MANAGER } from './cache.constants';

export interface CacheSetOptions {
  ttlSeconds: number;
  generation?: bigint;
}

export interface DomainCachePort {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options: CacheSetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  ping(): Promise<void>;
  getGeneration(domain: string): Promise<bigint>;
  applyGeneration(domain: string, generation: bigint): Promise<void>;
  applyGenerationStrict?(domain: string, generation: bigint): Promise<void>;
}

export { CACHE_MANAGER };
