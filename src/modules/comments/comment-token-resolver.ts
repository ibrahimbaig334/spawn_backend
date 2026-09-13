import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../infrastructure/database/prisma.service';

/**
 * Resolves a token reference to the data-layer tokens row id (uuid). Accepts
 * the token UUID, the on-chain token contract address, or the pool id.
 *
 * Purely on-chain launches have no offchain token row: when the ref resolves
 * to a sink pool/token but no backend row exists, a bare INDEXER-sourced row
 * is provisioned (names/uri copied from the sink) so comments, likes, and
 * profiles work for direct launches exactly like prepared ones.
 */
@Injectable()
export class CommentTokenResolver {
  async resolve(tx: Prisma.TransactionClient, tokenRef: string, chainId?: number): Promise<string> {
    const normalized = tokenRef.toLowerCase();
    const chain = chainId ?? Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
    const uuidLike =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized);
    if (uuidLike) {
      const token = await tx.token.findFirst({ where: { id: normalized }, select: { id: true } });
      if (token) return token.id;
      throw new NotFoundException({ code: 'TOKEN_NOT_FOUND' });
    }
    if (normalized.startsWith('0x') && normalized.length === 42) {
      const found = await tx.token.findFirst({
        where: { chainId: chain, token: normalized },
        select: { id: true },
      });
      if (found) return found.id;
      const provisioned = await this.provisionFromSink(tx, chain, normalized);
      if (provisioned) return provisioned;
    }
    if (normalized.startsWith('0x') && normalized.length === 66) {
      const pools = await tx.$queryRawUnsafe<{ token: string }[]>(
        `SELECT token FROM public.pools WHERE pool_id = '${normalized}' LIMIT 1`,
      );
      const token = pools[0]?.token?.toLowerCase();
      if (token) {
        const found = await tx.token.findFirst({
          where: { chainId: chain, token },
          select: { id: true },
        });
        if (found) return found.id;
        const provisioned = await this.provisionFromSink(tx, chain, token);
        if (provisioned) return provisioned;
      }
    }
    throw new NotFoundException({ code: 'TOKEN_NOT_FOUND' });
  }

  private async provisionFromSink(
    tx: Prisma.TransactionClient,
    chainId: number,
    token: string,
  ): Promise<string | null> {
    const rows = await tx.$queryRawUnsafe<{ name: string; symbol: string; uri: string }[]>(
      `SELECT name, symbol, uri FROM public.tokens WHERE token = '${token}'`,
    );
    const sink = rows[0];
    if (!sink) return null;
    try {
      const created = await tx.token.create({
        data: {
          chainId,
          token,
          name: sink.name || token,
          symbol: (sink.symbol || 'UNKNOWN').slice(0, 12),
          uri: sink.uri ?? '',
          source: 'INDEXER',
        },
        select: { id: true },
      });
      return created.id;
    } catch {
      // Lost a provision race: re-read the winner's row.
      const raced = await tx.token.findFirst({
        where: { chainId, token },
        select: { id: true },
      });
      return raced?.id ?? null;
    }
  }
}
