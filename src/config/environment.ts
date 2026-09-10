import { z } from 'zod';

const nodeEnvironments = ['development', 'test', 'production'] as const;
const processRoles = ['api', 'worker', 'seed'] as const;

function decodeEncryptionKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error('PRIVATE_KEY_ENCRYPTION_KEY must be canonical base64');
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw new Error('PRIVATE_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }

  return decoded;
}

const baseSchema = z.object({
  NODE_ENV: z.enum(nodeEnvironments).default('development'),
  PROCESS_ROLE: z.enum(processRoles).default('api'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  REDIS_URL: z.string().url().startsWith('redis://'),
  CORS_ORIGINS: z.string().default('http://localhost:3001'),
  TRUSTED_PROXY: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CHAIN_STALE_AFTER_SECONDS: z.coerce.number().int().positive().default(30),
  DEFAULT_CHAIN_ID: z.coerce.number().int().positive().default(8453),
  PRIVATE_KEY_ENCRYPTION_KEY: z.string().optional(),
  PRIVATE_KEY_ENCRYPTION_KEY_ID: z.string().trim().min(1).max(128).optional(),
  THIRDWEB_SECRET_KEY: z.string().trim().min(1).optional(),
  RATE_LIMIT_HMAC_KEY: z.string().min(32).optional(),
});

export type Environment = z.infer<typeof baseSchema> & {
  corsOrigins: string[];
  encryptionKey?: Buffer;
  trustedProxy: boolean | number | string[];
};

function parseTrustedProxy(value: string): boolean | number | string[] {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function validateEnvironment(input: Record<string, unknown>): Environment {
  const values = baseSchema.parse(input);
  const corsOrigins = values.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (values.NODE_ENV === 'production' && (corsOrigins.length === 0 || corsOrigins.includes('*'))) {
    throw new Error('Production CORS_ORIGINS must contain explicit origins');
  }

  if (values.NODE_ENV === 'production' && !values.RATE_LIMIT_HMAC_KEY) {
    throw new Error('Production requires RATE_LIMIT_HMAC_KEY');
  }

  const encryptionKey = values.PRIVATE_KEY_ENCRYPTION_KEY
    ? decodeEncryptionKey(values.PRIVATE_KEY_ENCRYPTION_KEY)
    : undefined;

  if (
    values.PROCESS_ROLE === 'api' &&
    (!encryptionKey || !values.PRIVATE_KEY_ENCRYPTION_KEY_ID || !values.THIRDWEB_SECRET_KEY)
  ) {
    throw new Error(
      'The API process requires signer encryption configuration and THIRDWEB_SECRET_KEY',
    );
  }

  return {
    ...values,
    corsOrigins,
    encryptionKey,
    trustedProxy: parseTrustedProxy(values.TRUSTED_PROXY),
  };
}
