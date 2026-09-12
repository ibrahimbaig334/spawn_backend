import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../infrastructure/database/prisma.service';

/**
 * Resolves a token reference to the data-layer tokens row id (uuid). Accepts the
 * token UUID or the on-chain token contract address.
 */
@Injectable()
export class CommentTokenResolver {
  async resolve(tx: Prisma.TransactionClient, tokenRef: string): Promise<string> {
    const normalized = tokenRef.toLowerCase();
    const uuidLike =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized);
    if (uuidLike) {
      const token = await tx.token.findFirst({ where: { id: normalized }, select: { id: true } });
      if (token) return token.id;
      throw new NotFoundException({ code: 'TOKEN_NOT_FOUND' });
    }
    if (normalized.startsWith('0x') && normalized.length === 42) {
      const token = await tx.token.findFirst({
        where: { token: normalized },
        select: { id: true },
      });
      if (token) return token.id;
    }
    throw new NotFoundException({ code: 'TOKEN_NOT_FOUND' });
  }
}
