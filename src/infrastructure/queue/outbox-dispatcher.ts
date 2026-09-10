import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '../cache/cache.constants';
import type { DomainCachePort } from '../cache/domain-cache.port';
import { PrismaService } from '../database/prisma.service';
import { COMMENT_CACHE_EVENT } from '../../modules/comments/comment-cache-generation';

@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: DomainCachePort,
  ) {}

  async dispatchBatch(): Promise<number> {
    const leaseOwner = `outbox:${process.pid}:${Date.now()}`;
    const events = await this.prisma.$transaction(async (tx) => {
      const candidates = await tx.outboxEvent.findMany({
        where: {
          publishedAt: null,
          availableAt: { lte: new Date() },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: new Date() } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      if (candidates.length === 0) return [];

      const ids = candidates.map((event) => event.id);
      await tx.outboxEvent.updateMany({
        where: {
          id: { in: ids },
          publishedAt: null,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: new Date() } }],
        },
        data: {
          leaseOwner,
          leaseExpiresAt: new Date(Date.now() + 30_000),
        },
      });
      return tx.outboxEvent.findMany({
        where: { id: { in: ids }, leaseOwner, publishedAt: null },
        orderBy: { createdAt: 'asc' },
      });
    });

    let published = 0;
    for (const event of events) {
      try {
        if (event.topic !== COMMENT_CACHE_EVENT) {
          throw new Error(`Unsupported outbox topic: ${event.topic}`);
        }
        await this.applyCacheGeneration(event.payload);
        const finalized = await this.prisma.outboxEvent.updateMany({
          where: { id: event.id, leaseOwner, publishedAt: null },
          data: {
            publishedAt: new Date(),
            attempts: { increment: 1 },
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: null,
          },
        });
        if (finalized.count === 1) published += 1;
      } catch (error) {
        const lastError = error instanceof Error ? error.message.slice(0, 1_000) : 'Unknown error';
        await this.prisma.outboxEvent.updateMany({
          where: { id: event.id, leaseOwner, publishedAt: null },
          data: {
            attempts: { increment: 1 },
            lastError,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        this.logger.error({ eventId: event.id, err: lastError }, 'Outbox dispatch failed');
      }
    }
    return published;
  }

  private async applyCacheGeneration(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid cache generation payload');
    }
    const domain = 'domain' in payload ? payload.domain : undefined;
    const generation = 'generation' in payload ? payload.generation : undefined;
    if (
      typeof domain !== 'string' ||
      typeof generation !== 'string' ||
      !/^\d+$/u.test(generation)
    ) {
      throw new Error('Invalid cache generation payload');
    }
    const generationValue = BigInt(generation);
    if (this.cache.applyGenerationStrict) {
      await this.cache.applyGenerationStrict(domain, generationValue);
      return;
    }
    await this.cache.applyGeneration(domain, generationValue);
  }
}
