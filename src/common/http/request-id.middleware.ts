import { createHash, randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: FastifyRequest, reply: FastifyReply, next: () => void): void {
    const supplied = request.headers['x-request-id'];
    const requestId =
      typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)
        ? supplied
        : randomUUID();
    Object.defineProperty(request, 'id', { value: requestId, configurable: true });
    reply.header('X-Request-Id', requestId);
    next();
  }
}

export function anonymize(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
