import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RATE_LIMIT_POLICY } from './rate-limit.decorator';
import { RATE_LIMIT_POLICIES, type RateLimitPolicy } from './rate-limit.policy';
import { RATE_LIMITER, type RateLimiterPort } from './rate-limiter.port';

@Injectable()
export class MutationRateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiterPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) return true;

    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const policy =
      this.reflector.getAllAndOverride<RateLimitPolicy>(RATE_LIMIT_POLICY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? RATE_LIMIT_POLICIES.general;
    const wallet = this.wallet(request);
    const results = await Promise.all([
      this.limiter.check(`ip:${request.ip}`, policy.ipLimit, policy.windowSeconds),
      wallet
        ? this.limiter.check(`wallet:${wallet}`, policy.walletLimit, policy.windowSeconds)
        : Promise.resolve(null),
    ]);
    const failed = results.filter((result) => result && !result.allowed).at(0);
    const effective = failed ?? results[1] ?? results[0];

    reply.header('RateLimit-Limit', effective.limit);
    reply.header('RateLimit-Remaining', effective.remaining);
    reply.header('RateLimit-Reset', effective.resetSeconds);
    if (failed) {
      reply.header('Retry-After', failed.resetSeconds);
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Rate limit exceeded' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  private wallet(request: FastifyRequest): string | undefined {
    const body = request.body as Record<string, unknown> | undefined;
    const params = request.params as Record<string, unknown> | undefined;
    const query = request.query as Record<string, unknown> | undefined;
    const value =
      body?.walletAddress ??
      body?.creatorWalletAddress ??
      params?.walletAddress ??
      query?.walletAddress;
    return typeof value === 'string' ? value.toLowerCase() : undefined;
  }
}
