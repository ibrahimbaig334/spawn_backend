import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class CommentTokenResolver {
  async resolve(tx: Prisma.TransactionClient, tokenRef: string, chainId = 8453): Promise<string> {
    const normalized = tokenRef.toLowerCase();
    if (isUuid(normalized)) {
      const token = await tx.token.findUnique({ where: { id: normalized }, select: { id: true } });
      if (token) return token.id;
      throw new NotFoundException({ code: 'TOKEN_NOT_FOUND' });
    }
    const watermark = await tx.chainWatermark.findUnique({ where: { chainId } });
    if (!watermark) throw new NotFoundException({ code: 'TOKEN_NOT_FOUND' });
    const projection = await tx.tokenChainState.findFirst({
      where: {
        chainId,
        contractAddress: normalized,
        projectionVersion: { lte: watermark.committedVersion },
      },
      select: { tokenId: true },
    });
    if (!projection) throw new NotFoundException({ code: 'TOKEN_NOT_FOUND' });
    return projection.tokenId;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}
