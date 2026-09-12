import type { ProjectorContext } from './projection-applier';

/** Prisma Decimal(78,0) columns accept exact integer strings. */
export function big(value: bigint | number | string): string {
  return value.toString();
}

/** "<block_number>:<log_ordinal>" — the fact-table PK convention (guide §1). */
export function ordinalKey(ctx: ProjectorContext): string {
  return `${ctx.blockNumber}:${ctx.logIndex}`;
}
