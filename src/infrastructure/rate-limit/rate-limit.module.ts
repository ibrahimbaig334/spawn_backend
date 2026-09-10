import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MutationRateLimitGuard } from './mutation-rate-limit.guard';
import { RATE_LIMITER } from './rate-limiter.port';
import { RedisRateLimiter } from './redis-rate-limiter';

@Global()
@Module({
  providers: [
    { provide: RATE_LIMITER, useClass: RedisRateLimiter },
    { provide: APP_GUARD, useClass: MutationRateLimitGuard },
  ],
  exports: [RATE_LIMITER],
})
export class RateLimitModule {}
