import { z } from 'zod';

/**
 * Address book for a single chain, sourced from the deployment manifest written by
 * `script/Deploy.s.sol` (deployments/<chainId>.json) with environment overrides on top.
 *
 * The protocol is not deployed yet at the time of writing; every consumer must source
 * addresses from this module and never hardcode one elsewhere.
 */

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'address must be a 0x-prefixed 40-hex string')
  .transform((value) => value.toLowerCase());

const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'bytes32 must be a 0x-prefixed 64-hex string')
  .transform((value) => value.toLowerCase());

const wadSchema = z.string().regex(/^\d+$/, 'wad-sized values are decimal strings');

export const deploymentManifestSchema = z.object({
  chainId: z.coerce.number().int().positive(),
  hook: addressSchema,
  launchSupport: addressSchema,
  revenueNft: addressSchema,
  payoutPluginRegistry: addressSchema,
  protocolController: addressSchema,
  buybackAndBurnPlugin: addressSchema.nullish(),
  // Deploy.s.sol writes this key as `buybackPlugin`.
  buybackPlugin: addressSchema.nullish(),
  poolManager: addressSchema.optional(),
  stateView: addressSchema.nullish(),
  v4Quoter: addressSchema.nullish(),
  multicall3: addressSchema.optional(),
  canonicalPayoutPlan: bytes32Schema.nullish(),
  hookSalt: bytes32Schema.nullish(),
  template: z
    .object({
      openingFdvWei: wadSchema,
      curvePositions: z.coerce.number().int(),
      curveSpanLevels: z.coerce.number().int(),
      bandLevelSpacing: z.coerce.number().int(),
      bandWidthLevels: z.coerce.number().int(),
      coreBandCount: z.coerce.number().int(),
      maxFeeFundedBands: z.coerce.number().int(),
      curveSupplyShareWad: wadSchema,
      ladderSupplyShareWad: wadSchema,
      fullRangeSupplyShareWad: wadSchema,
      lpSeedWad: wadSchema,
      proceedsCreatorWad: wadSchema,
      proceedsProtocolWad: wadSchema,
      tradingFeeHundredthsBip: z.coerce.number().int(),
      bandInventoryCapMultiple: z.coerce.number().int(),
      maxDeploysPerSwap: z.coerce.number().int(),
      maxHarvestsPerSwap: z.coerce.number().int(),
    })
    .optional(),
});

export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;

export type AddressBook = {
  chainId: number;
  hook: string;
  launchSupport: string;
  revenueNft: string;
  payoutPluginRegistry: string;
  protocolController: string;
  buybackAndBurnPlugin?: string;
  poolManager: string;
  stateView?: string;
  v4Quoter?: string;
  multicall3: string;
  canonicalPayoutPlan?: string;
  hookSalt?: string;
};

/** Well-known third-party deployments (Uniswap v4 on Base, Multicall3). */
export const KNOWN_ADDRESSES: Record<number, { poolManager: string; multicall3: string }> = {
  8453: {
    poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
    multicall3: '0xca11bde05977b3631167028862be2a173976ca11',
  },
  84532: {
    // Base Sepolia testnet; PoolManager per Uniswap's published testnet deployments.
    poolManager: '0x7a9a54d308b0e6806b1bf3343d3e905939166b43',
    multicall3: '0xca11bde05977b3631167028862be2a173976ca11',
  },
};

const REQUIRED_PROTOCOL_KEYS = [
  'hook',
  'launchSupport',
  'revenueNft',
  'payoutPluginRegistry',
  'protocolController',
] as const;

type ProtocolAddressKey = (typeof REQUIRED_PROTOCOL_KEYS)[number];

const ENV_OVERRIDE_KEYS: Record<ProtocolAddressKey, string> = {
  hook: 'SPAWN_HOOK_ADDRESS',
  launchSupport: 'SPAWN_LAUNCH_SUPPORT_ADDRESS',
  revenueNft: 'SPAWN_REVENUE_NFT_ADDRESS',
  payoutPluginRegistry: 'SPAWN_REGISTRY_ADDRESS',
  protocolController: 'SPAWN_CONTROLLER_ADDRESS',
};

export class AddressBookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressBookError';
  }
}

function readEnvOverrides(): Partial<Record<ProtocolAddressKey, string>> {
  const overrides: Partial<Record<ProtocolAddressKey, string>> = {};
  for (const key of REQUIRED_PROTOCOL_KEYS) {
    const raw = process.env[ENV_OVERRIDE_KEYS[key]];
    if (raw && raw.trim()) {
      const parsed = addressSchema.safeParse(raw.trim());
      if (!parsed.success) {
        throw new AddressBookError(`${ENV_OVERRIDE_KEYS[key]} is not a valid address: ${raw}`);
      }
      overrides[key] = parsed.data;
    }
  }
  return overrides;
}

function readInfraOverrides(): {
  poolManager?: string;
  stateView?: string;
  v4Quoter?: string;
  multicall3?: string;
} {
  const result: {
    poolManager?: string;
    stateView?: string;
    v4Quoter?: string;
    multicall3?: string;
  } = {};
  const poolManager = process.env.POOL_MANAGER_ADDRESS;
  if (poolManager?.trim()) result.poolManager = addressSchema.parse(poolManager.trim());
  const stateView = process.env.STATE_VIEW_ADDRESS;
  if (stateView?.trim()) result.stateView = addressSchema.parse(stateView.trim());
  const v4Quoter = process.env.V4_QUOTER_ADDRESS;
  if (v4Quoter?.trim()) result.v4Quoter = addressSchema.parse(v4Quoter.trim());
  const multicall3 = process.env.MULTICALL3_ADDRESS;
  if (multicall3?.trim()) result.multicall3 = addressSchema.parse(multicall3.trim());
  return result;
}

/**
 * Builds the address book for a chain. Precedence (highest wins):
 *  1. Environment overrides (per contract)
 *  2. The manifest supplied by the caller (parsed from deployments/<chainId>.json)
 *  3. Well-known third-party infra addresses for the chain
 *
 * Protocol contracts (hook, satellites, registry, controller) have no well-known
 * defaults: without a manifest or overrides the address book cannot be built and the
 * caller must handle the AddressBookError (e.g. run in API-only degraded mode).
 */
export function buildAddressBook(chainId: number, manifest?: unknown): AddressBook {
  const envOverrides = readEnvOverrides();
  const infraOverrides = readInfraOverrides();
  const known = KNOWN_ADDRESSES[chainId];

  let parsed: DeploymentManifest | undefined;
  if (manifest !== undefined) {
    const result = deploymentManifestSchema.safeParse(manifest);
    if (!result.success) {
      throw new AddressBookError(
        `Deployment manifest for chain ${chainId} failed validation: ${result.error.message}`,
      );
    }
    if (result.data.chainId !== chainId) {
      throw new AddressBookError(
        `Deployment manifest chainId ${result.data.chainId} does not match requested chain ${chainId}`,
      );
    }
    parsed = result.data;
  }

  const protocol = {} as Record<ProtocolAddressKey, string | undefined>;
  for (const key of REQUIRED_PROTOCOL_KEYS) {
    protocol[key] = envOverrides[key] ?? parsed?.[key];
  }

  const missing = REQUIRED_PROTOCOL_KEYS.filter((key) => !protocol[key]);
  if (missing.length > 0) {
    throw new AddressBookError(
      `Missing protocol addresses for chain ${chainId}: ${missing.join(', ')}. ` +
        'Provide a deployment manifest or set the SPAWN_*_ADDRESS environment overrides.',
    );
  }

  const poolManager = infraOverrides.poolManager ?? parsed?.poolManager ?? known?.poolManager;
  const stateView = infraOverrides.stateView ?? parsed?.stateView;
  const v4Quoter = infraOverrides.v4Quoter ?? parsed?.v4Quoter;
  const multicall3 = infraOverrides.multicall3 ?? parsed?.multicall3 ?? known?.multicall3;

  if (!poolManager) {
    throw new AddressBookError(
      `Missing PoolManager address for chain ${chainId}. Set POOL_MANAGER_ADDRESS or include it in the manifest.`,
    );
  }
  if (!multicall3) {
    throw new AddressBookError(
      `Missing Multicall3 address for chain ${chainId}. Set MULTICALL3_ADDRESS or include it in the manifest.`,
    );
  }

  return {
    chainId,
    hook: protocol.hook!,
    launchSupport: protocol.launchSupport!,
    revenueNft: protocol.revenueNft!,
    payoutPluginRegistry: protocol.payoutPluginRegistry!,
    protocolController: protocol.protocolController!,
    // Deployment artifacts name the key `buybackPlugin`; accept both.
    buybackAndBurnPlugin: parsed?.buybackAndBurnPlugin ?? parsed?.buybackPlugin ?? undefined,
    poolManager,
    stateView: stateView ?? undefined,
    v4Quoter: v4Quoter ?? undefined,
    multicall3,
    canonicalPayoutPlan: parsed?.canonicalPayoutPlan ?? undefined,
    hookSalt: parsed?.hookSalt ?? undefined,
  };
}
