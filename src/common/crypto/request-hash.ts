import { createHash } from 'node:crypto';

export function requestHash(value: string): string {
  return `0x${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
