import { DomainException } from './domain.exception';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

export function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[ -~]{1,128}$/.test(value)) {
    throw new DomainException(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must contain 1 to 128 printable ASCII characters',
    );
  }
  return value;
}
