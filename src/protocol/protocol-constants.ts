/**
 * Immutable protocol template constants (Bounds.defaultTemplate) and orientation math
 * boundaries. These mirror the on-chain template; the live values must always be read
 * from the hook's `template()` view — the loader reconciles against this default and
 * fails closed when a deployment generation changes them.
 */

export const PROTOCOL_TEMPLATE_DEFAULT = {
  openingFdvWei: '2000000000000000000', // 2e18 ETH FDV at the pinned 1e27 supply
  curvePositions: 32,
  curveSpanLevels: 13862, // 2 * LEVELS_PER_DOUBLING (4x opening: two 2x spans)
  bandLevelSpacing: 2235, // ladder spacing FLOOR: 1.2504x market-cap step
  bandFirstStepLevels: 6932, // first step above graduation: 2.0004x
  bandStepDecayLevels: 391, // each successive step shrinks by this many levels
  bandWidthLevels: 447,
  coreBandCount: 22,
  maxFeeFundedBands: 30,
  curveSupplyShareWad: '250000000000000000', // 0.25e18 — bonding curve
  ladderSupplyShareWad: '100000000000000000', // 0.10e18 — milestone ladder
  fullRangeSupplyShareWad: '650000000000000000', // 0.65e18 — graduation full-range + wall
  lpSeedWad: '200000000000000000', // 0.20e18
  proceedsCreatorWad: '700000000000000000', // 0.70e18
  proceedsProtocolWad: '100000000000000000', // 0.10e18
  tradingFeeHundredthsBip: 10_000, // static 1% Uniswap fee
  bandInventoryCapMultiple: 2,
  maxDeploysPerSwap: 8,
  maxHarvestsPerSwap: 8,
} as const;

export const ECONOMICS_DEFAULT = {
  harvestServiceFeeWad: '100000000000000000', // 0.10e18 (cap 0.20e18)
  quoteCreatorShareWad: '750000000000000000', // 0.75e18 (cap 0.90e18)
  tokenMilestoneFundShareWad: '1000000000000000000', // 1.00e18 — 100% to the milestone fund (cap 1.00e18)
  version: 1n,
} as const;

export const ECONOMICS_CAPS = {
  maxHarvestServiceFeeWad: '200000000000000000',
  maxQuoteCreatorShareWad: '900000000000000000',
  maxTokenMilestoneFundShareWad: '1000000000000000000',
} as const;

export const POOL_TICK_SPACING = 1;
export const MAX_DEV_BUY_SHARE_WAD = '100000000000000000'; // 0.1e18
/** Only total supply a launch may declare: 1,000,000,000 with 18 decimals. */
export const FIXED_TOTAL_SUPPLY = '1000000000000000000000000000';
export const FLUSH_TIP_BPS = 100; // floor 1% of a newly redeemed pot
export const WAD = 1_000_000_000_000_000_000n;
export const FEE_DENOMINATOR = 1_000_000n;
export const MAX_BAND_COUNT = 256;

/**
 * Graduation full-range position bounds (Bounds.FULL_RANGE_TICK_*): the $5,100→$150B
 * FDV market-cap band at the pinned supply; the cheap bound is the hard price floor.
 */
export const FULL_RANGE_TICK_LOWER = 28_135;
export const FULL_RANGE_TICK_UPPER = 200_114;
/** Wall position: token-only, [graduationLevel+1, graduationLevel+880000]. */
export const WALL_WIDTH_LEVELS = 880_000;

/** Uniswap v4 tick space boundaries. */
export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;
export const MIN_SQRT_PRICE = 4_295_128_739n;
export const MAX_SQRT_PRICE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;

/** level = -tick orientation space boundaries (Orientation.MIN_LEVEL / MAX_LEVEL). */
export const MIN_LEVEL = -MAX_TICK;
export const MAX_LEVEL = -MIN_TICK;

export const EIP712_DOMAIN = {
  name: 'SpawnLaunchpad',
  version: '1',
} as const;

export const LAUNCH_CONFIG_TYPEHASH_STRING =
  'LaunchConfig(address creator,string name,string symbol,string uri,uint256 totalSupply,uint64 devBuyShareWad,uint256 payoutPlan,uint256 deadline)';

/** AccrualSource enum (MilestoneBase.AccrualSource). */
export const ACCRUAL_SOURCES = ['CURVE_PROCEEDS', 'SWAP_FEES', 'MILESTONE_HARVEST'] as const;
export type AccrualSource = (typeof ACCRUAL_SOURCES)[number];
export const accrualSourceFromUint8 = (value: number): AccrualSource | null =>
  ((ACCRUAL_SOURCES as readonly string[])[value] as AccrualSource | undefined) ?? null;

/** PluginRole enum. */
export const PLUGIN_ROLES = ['INVALID', 'PAYOUT', 'CREATOR_SYSTEM', 'UTILITY'] as const;
export type PluginRole = (typeof PLUGIN_ROLES)[number];
export const pluginRoleFromUint8 = (value: number): PluginRole | null =>
  ((PLUGIN_ROLES as readonly string[])[value] as PluginRole | undefined) ?? null;

/** Phase enum. */
export const PHASES = ['NONE', 'BONDING_CURVE', 'GRADUATED'] as const;
export type Phase = (typeof PHASES)[number];
export const phaseFromUint8 = (value: number): Phase | null =>
  ((PHASES as readonly string[])[value] as Phase | undefined) ?? null;
