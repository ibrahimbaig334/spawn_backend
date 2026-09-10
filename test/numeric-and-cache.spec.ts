import { Prisma } from '@prisma/client';
import { serializeNumeric } from '../src/common/serialization/numeric.serializer';

describe('numeric serialization', () => {
  it('preserves exact numeric values and UTC dates', () => {
    const value = {
      raw: 900719925474099312345678901234567890n,
      price: new Prisma.Decimal('0.123456789012345678901234567890123456'),
      timestamp: new Date('2026-09-09T12:34:56.789Z'),
    };

    expect(serializeNumeric(value)).toEqual({
      raw: '900719925474099312345678901234567890',
      price: '0.123456789012345678901234567890123456',
      timestamp: '2026-09-09T12:34:56.789Z',
    });
  });
});
