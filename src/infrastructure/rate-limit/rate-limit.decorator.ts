import { SetMetadata } from '@nestjs/common';
import type { RateLimitPolicy } from './rate-limit.policy';

export const RATE_LIMIT_POLICY = 'rate-limit-policy';
export const RateLimit = (policy: RateLimitPolicy): MethodDecorator =>
  SetMetadata(RATE_LIMIT_POLICY, policy);
