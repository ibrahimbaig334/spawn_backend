import { z } from 'zod';

const nodeEnvironments = ['development', 'test', 'production'] as const;
const processRoles = ['api', 'worker', 'indexer', 'broadcaster', 'seed'] as const;

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

  // Chain configuration
  DEFAULT_CHAIN_ID: z.coerce.number().int().positive().default(8453),
  CHAIN_RPC_URLS: z.string().default(''),
  SPAWN_HOOK_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  SPAWN_LAUNCH_SUPPORT_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  SPAWN_REVENUE_NFT_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  SPAWN_REGISTRY_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  SPAWN_CONTROLLER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  POOL_MANAGER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  STATE_VIEW_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  V4_QUOTER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  MULTICALL3_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),

  // Indexer configuration
  INDEXER_START_BLOCK: z.coerce.number().int().min(0).optional(),
  INDEXER_CONFIRMATION_BLOCKS: z.coerce.number().int().min(1).max(1000).default(32),
  INDEXER_BLOCK_BATCH: z.coerce.number().int().min(1).max(500).default(50),
  INDEXER_POLL_MS: z.coerce.number().int().min(250).default(3000),
  INDEXER_MAX_REORG_DEPTH: z.coerce.number().int().min(1).max(10000).default(256),

  // Trusted operator key for relayed launches (BACKEND_GUIDE §6.1). In production
  // this lives in an HSM/Vault; the env var is the staging path. The address must
  // match the on-chain `trustedOperator` (protocol_state.trusted_operator).
  TRUSTED_OPERATOR_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),

  // WS broadcaster (pg LISTEN → tick/bar streams)
  BROADCASTER_WS_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  // Token metadata / image storage. Pinata pins server-side (JWT never
  // reaches the browser); thirdweb is kept as a fallback driver.
  METADATA_STORAGE_DRIVER: z.enum(['pinata', 'thirdweb']).default('pinata'),
  PINATA_JWT: z.string().trim().min(1).optional(),
  PINATA_GATEWAY: z.string().trim().url().default('https://gateway.pinata.cloud/ipfs'),
  // Thirdweb storage (token metadata uploads; fallback driver only)
  THIRDWEB_SECRET_KEY: z.string().trim().min(1).optional(),

  // Rate limiting
  RATE_LIMIT_HMAC_KEY: z.string().min(32).optional(),
});

export type Environment = z.infer<typeof baseSchema> & {
  corsOrigins: string[];
  chainRpcUrls: string[];
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

  const indexerRequiresRpc = values.PROCESS_ROLE === 'indexer';
  const chainRpcUrls = values.CHAIN_RPC_URLS.split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  if (indexerRequiresRpc && chainRpcUrls.length === 0) {
    throw new Error('The indexer process requires CHAIN_RPC_URLS');
  }

  return {
    ...values,
    corsOrigins,
    chainRpcUrls,
    trustedProxy: parseTrustedProxy(values.TRUSTED_PROXY),
  };
}
