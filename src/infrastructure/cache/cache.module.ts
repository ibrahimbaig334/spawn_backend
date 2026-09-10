import { Global, Module } from '@nestjs/common';
import { CACHE_MANAGER } from './cache.constants';
import { RedisDomainCache } from './redis-domain-cache';

@Global()
@Module({
  providers: [{ provide: CACHE_MANAGER, useClass: RedisDomainCache }],
  exports: [CACHE_MANAGER],
})
export class CacheModule {}
