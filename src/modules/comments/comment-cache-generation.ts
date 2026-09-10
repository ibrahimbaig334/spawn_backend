import type { Prisma } from '@prisma/client';

export const COMMENT_CACHE_EVENT = 'APPLY_CACHE_GENERATION';

export function commentCacheDomain(tokenId: string): string {
  return `comments:${tokenId}`;
}

export async function advanceCommentCacheGeneration(
  tx: Prisma.TransactionClient,
  tokenId: string,
): Promise<bigint> {
  const domain = commentCacheDomain(tokenId);
  const row = await tx.domainGeneration.upsert({
    where: { domain },
    create: { domain, generation: 1n },
    update: { generation: { increment: 1 } },
    select: { generation: true },
  });
  await tx.outboxEvent.create({
    data: {
      topic: COMMENT_CACHE_EVENT,
      aggregateId: domain,
      payload: { domain, generation: row.generation.toString() },
    },
  });
  return row.generation;
}
