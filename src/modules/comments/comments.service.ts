import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { IdempotencyState, Prisma } from '@prisma/client';
import { canonicalize } from 'json-canonicalize';
import { requestHash } from '../../common/crypto/request-hash';
import { pageMeta, type PageResult } from '../../common/pagination/page-result';
import { CACHE_MANAGER } from '../../infrastructure/cache/cache.constants';
import { CACHE_TTL_SECONDS } from '../../infrastructure/cache/cache-ttl';
import type { DomainCachePort } from '../../infrastructure/cache/domain-cache.port';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { advanceCommentCacheGeneration, commentCacheDomain } from './comment-cache-generation';
import { CommentTokenResolver } from './comment-token-resolver';
import type { CreateCommentDto } from './dto/comment-mutation.dto';
import type { CommentRepliesQueryDto, CommentsQueryDto } from './dto/comment-query.dto';

const COMMENT_SCOPE = 'POST:/api/v1/tokens/:tokenRef/comments';
const IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

@Injectable()
export class CommentsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CommentTokenResolver) private readonly tokenResolver: CommentTokenResolver,
    @Inject(CACHE_MANAGER) private readonly cache: DomainCachePort,
  ) {}

  async create(
    tokenRef: string,
    input: CreateCommentDto,
    idempotencyKey: string,
  ): Promise<{ value: unknown; replayed: boolean }> {
    const tokenId = await this.prisma.$transaction((tx) =>
      this.tokenResolver.resolve(tx, tokenRef),
    );
    const hash = requestHash(canonicalize({ tokenId, ...input }));
    const idempotencyWhere = {
      scope_walletAddress_key: {
        scope: COMMENT_SCOPE,
        walletAddress: input.walletAddress,
        key: idempotencyKey,
      },
    } as const;
    const existing = await this.prisma.idempotencyRequest.findUnique({ where: idempotencyWhere });
    if (existing) return this.replay(existing, hash);
    try {
      const comment = await this.prisma.$transaction(
        async (tx) => {
          await tx.idempotencyRequest.create({
            data: {
              scope: COMMENT_SCOPE,
              walletAddress: input.walletAddress,
              key: idempotencyKey,
              requestHash: hash,
              expiresAt: new Date(Date.now() + IDEMPOTENCY_RETENTION_MS),
            },
          });
          await tx.profile.upsert({
            where: { walletAddress: input.walletAddress },
            create: { walletAddress: input.walletAddress },
            update: {},
          });
          const id = randomUUID();
          if (input.parentCommentId) {
            const parent = await tx.comment.findUnique({ where: { id: input.parentCommentId } });
            if (!parent || parent.tokenDbId !== tokenId)
              throw new NotFoundException({ code: 'COMMENT_PARENT_NOT_FOUND' });
            if (parent.isDeleted) throw new ConflictException({ code: 'COMMENT_PARENT_DELETED' });
            if (parent.depth >= 3) throw new ConflictException({ code: 'COMMENT_MAX_DEPTH' });
          }
          const created = await tx.comment.create({
            data: {
              id,
              tokenDbId: tokenId,
              walletAddress: input.walletAddress,
              parentId: input.parentCommentId,
              rootId: id,
              depth: 0,
              text: input.text,
            },
            include: { author: true },
          });
          if (input.parentCommentId) {
            await tx.comment.update({
              where: { id: input.parentCommentId },
              data: { replyCount: { increment: 1 } },
            });
          }
          await tx.idempotencyRequest.update({
            where: idempotencyWhere,
            data: {
              state: IdempotencyState.COMPLETED,
              responseStatus: 201,
              resourceId: created.id,
            },
          });
          const generation = await advanceCommentCacheGeneration(tx, tokenId);
          return { created, generation };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      await this.cache.applyGeneration(commentCacheDomain(tokenId), comment.generation);
      return { value: comment.created, replayed: false };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await this.prisma.idempotencyRequest.findUniqueOrThrow({
        where: idempotencyWhere,
      });
      return this.replay(raced, hash);
    }
  }

  async list(tokenRef: string, query: CommentsQueryDto): Promise<PageResult<unknown>> {
    const tokenId = await this.prisma.$transaction((tx) =>
      this.tokenResolver.resolve(tx, tokenRef),
    );
    const generation = await this.commentGeneration(tokenId);
    const key = this.cacheKey(`comments:${tokenId}:${generation}:roots`, query);
    const cached = await this.cache.get<PageResult<unknown>>(key);
    if (cached) return cached;
    const where: Prisma.CommentWhereInput = { tokenDbId: tokenId, parentId: null };
    const orderBy: Prisma.CommentOrderByWithRelationInput[] =
      query.sort === 'oldest'
        ? [{ createdAt: 'asc' }, { id: 'asc' }]
        : query.sort === 'top'
          ? [{ likeCount: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }]
          : [{ createdAt: 'desc' }, { id: 'asc' }];
    const [total, roots] = await this.prisma.$transaction([
      this.prisma.comment.count({ where }),
      this.prisma.comment.findMany({
        where,
        include: {
          author: true,
          replies: {
            include: { author: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: 3,
          },
        },
        orderBy,
        skip: query.skip,
        take: query.limit,
      }),
    ]);
    const result = { data: roots, meta: pageMeta(query.page, query.limit, total) };
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.comments });
    return result;
  }

  async replies(commentId: string, query: CommentRepliesQueryDto): Promise<PageResult<unknown>> {
    const comment = await this.requireComment(commentId);
    const generation = await this.commentGeneration(comment.tokenDbId);
    const key = this.cacheKey(
      `comments:${comment.tokenDbId}:${generation}:replies:${commentId}`,
      query,
    );
    const cached = await this.cache.get<PageResult<unknown>>(key);
    if (cached) return cached;
    const where: Prisma.CommentWhereInput = { parentId: commentId };
    const [total, data] = await this.prisma.$transaction([
      this.prisma.comment.count({ where }),
      this.prisma.comment.findMany({
        where,
        include: { author: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
    ]);
    const result = { data, meta: pageMeta(query.page, query.limit, total) };
    await this.cache.set(key, result, { ttlSeconds: CACHE_TTL_SECONDS.comments });
    return result;
  }

  async delete(commentId: string, walletAddress: string): Promise<unknown> {
    const result = await this.prisma.$transaction(
      async (tx) => {
        const comment = await tx.comment.findUnique({ where: { id: commentId } });
        if (!comment || comment.walletAddress !== walletAddress)
          throw new NotFoundException({ code: 'COMMENT_NOT_FOUND' });
        if (comment.isDeleted) return { deleted: comment, generation: null };
        const deleted = await tx.comment.update({
          where: { id: commentId },
          data: { isDeleted: true, text: null, deletedAt: new Date() },
        });
        if (comment.parentId) {
          await tx.comment.update({
            where: { id: comment.parentId },
            data: { replyCount: { decrement: 1 } },
          });
        }
        const generation = await advanceCommentCacheGeneration(tx, comment.tokenDbId);
        return { deleted, generation };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    if (result.generation !== null) {
      await this.cache.applyGeneration(
        commentCacheDomain(result.deleted.tokenDbId),
        result.generation,
      );
    }
    return result.deleted;
  }

  private async replay(
    existing: { requestHash: string; state: IdempotencyState; resourceId: string | null },
    hash: string,
  ): Promise<{ value: unknown; replayed: true }> {
    if (existing.requestHash !== hash)
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
    if (existing.state !== IdempotencyState.COMPLETED || !existing.resourceId)
      throw new ConflictException({ code: 'REQUEST_IN_PROGRESS' });
    const comment = await this.prisma.comment.findUnique({
      where: { id: existing.resourceId },
      include: { author: true },
    });
    if (!comment) throw new NotFoundException({ code: 'COMMENT_NOT_FOUND' });
    return { value: comment, replayed: true };
  }

  private async requireComment(commentId: string): Promise<{ tokenDbId: string }> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { tokenDbId: true },
    });
    if (!comment) throw new NotFoundException({ code: 'COMMENT_NOT_FOUND' });
    return comment;
  }

  private async commentGeneration(tokenId: string): Promise<string> {
    const domain = commentCacheDomain(tokenId);
    const cached = await this.cache.getGeneration(domain);
    if (cached > 0n) return cached.toString();
    const persisted = await this.prisma.domainGeneration.findUnique({ where: { domain } });
    if (!persisted) return '0';
    await this.cache.applyGeneration(domain, persisted.generation);
    return persisted.generation.toString();
  }

  private cacheKey(prefix: string, query: object): string {
    return `${prefix}:${JSON.stringify(Object.fromEntries(Object.entries(query).sort(([a], [b]) => a.localeCompare(b))))}`;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
