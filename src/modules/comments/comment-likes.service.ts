import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CACHE_MANAGER } from '../../infrastructure/cache/cache.constants';
import { CACHE_TTL_SECONDS } from '../../infrastructure/cache/cache-ttl';
import type { DomainCachePort } from '../../infrastructure/cache/domain-cache.port';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { advanceCommentCacheGeneration, commentCacheDomain } from './comment-cache-generation';

@Injectable()
export class CommentLikesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: DomainCachePort,
  ) {}

  async status(commentId: string, walletAddress: string): Promise<Record<string, unknown>> {
    const key = this.key(commentId, walletAddress);
    const cached = await this.cache.get<Record<string, unknown>>(key);
    if (cached) return cached;
    const [comment, like] = await Promise.all([
      this.prisma.comment.findUnique({
        where: { id: commentId },
        select: { isDeleted: true, likeCount: true },
      }),
      this.prisma.commentLike.findUnique({
        where: { commentId_walletAddress: { commentId, walletAddress } },
      }),
    ]);
    if (!comment) throw new NotFoundException({ code: 'COMMENT_NOT_FOUND' });
    const result = { commentId, walletAddress, liked: like !== null, likeCount: comment.likeCount };
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.likeStatus });
    return result;
  }

  async like(commentId: string, walletAddress: string): Promise<Record<string, unknown>> {
    const result = await this.prisma.$transaction(
      async (tx) => {
        const comment = await tx.comment.findUnique({ where: { id: commentId } });
        if (!comment || comment.isDeleted)
          throw new NotFoundException({ code: 'COMMENT_NOT_FOUND' });
        await tx.profile.upsert({
          where: { walletAddress },
          create: { walletAddress },
          update: {},
        });
        const inserted = await tx.$executeRaw(Prisma.sql`
          INSERT INTO comment_likes ("commentId", "walletAddress", "createdAt")
          VALUES (${commentId}::uuid, ${walletAddress}, CURRENT_TIMESTAMP)
          ON CONFLICT DO NOTHING
        `);
        const updated = inserted
          ? await tx.comment.update({
              where: { id: commentId },
              data: { likeCount: { increment: 1 } },
            })
          : comment;
        const generation = inserted
          ? await advanceCommentCacheGeneration(tx, comment.tokenId)
          : null;
        return {
          value: { commentId, walletAddress, liked: true, likeCount: updated.likeCount },
          generation,
          tokenId: comment.tokenId,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await this.cache.delete(this.key(commentId, walletAddress));
    if (result.generation !== null) {
      await this.cache.applyGeneration(commentCacheDomain(result.tokenId), result.generation);
    }
    return result.value;
  }

  async unlike(commentId: string, walletAddress: string): Promise<Record<string, unknown>> {
    const result = await this.prisma.$transaction(
      async (tx) => {
        const comment = await tx.comment.findUnique({ where: { id: commentId } });
        if (!comment) throw new NotFoundException({ code: 'COMMENT_NOT_FOUND' });
        const removed = await tx.commentLike.deleteMany({ where: { commentId, walletAddress } });
        const updated = removed.count
          ? await tx.comment.update({
              where: { id: commentId },
              data: { likeCount: { decrement: 1 } },
            })
          : comment;
        const generation = removed.count
          ? await advanceCommentCacheGeneration(tx, comment.tokenId)
          : null;
        return {
          value: { commentId, walletAddress, liked: false, likeCount: updated.likeCount },
          generation,
          tokenId: comment.tokenId,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await this.cache.delete(this.key(commentId, walletAddress));
    if (result.generation !== null) {
      await this.cache.applyGeneration(commentCacheDomain(result.tokenId), result.generation);
    }
    return result.value;
  }

  private key(commentId: string, walletAddress: string): string {
    return `comments:${commentId}:likes:${walletAddress}`;
  }
}
