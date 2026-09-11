/**
 * Immutable protocol template constants (Bounds.defaultTemplate) and orientation math
 * boundaries. These mirror the on-chain template; the live values must always be read
 * from the hook's `template()` view — the loader reconciles against this default and
 * fails closed when a deployment generation changes them.
 */

export const PROTOCOL_TEMPLATE_DEFAULT = {
  openingFdvWei: '125000000000000000000', // 125e18
  curvePositions: 32,
  curveSpanLevels: 6931, // LEVELS_PER_DOUBLING: a 2x market-cap step
  bandLevelSpacing: 2235, // ~1.2504x market-cap step per ladder rung
  bandWidthLevels: 447, // one band wall, a fifth of the spacing
  coreBandCount: 30,
  maxFeeFundedBands: 30,
  curveSupplyShareWad: '250000000000000000', // 0.25e18
  ladderSupplyShareWad: '650000000000000000', // 0.65e18
  fullRangeSupplyShareWad: '100000000000000000', // 0.1e18
  lpSeedWad: '400000000000000000', // 0.4e18
  proceedsCreatorWad: '550000000000000000', // 0.55e18
  proceedsProtocolWad: '50000000000000000', // 0.05e18
  tradingFeeHundredthsBip: 10_000, // static 1% Uniswap fee
  bandInventoryCapMultiple: 2,
  maxDeploysPerSwap: 8,
  maxHarvestsPerSwap: 8,
} as const;

export const ECONOMICS_DEFAULT = {
  harvestServiceFeeWad: '100000000000000000', // 0.10e18, immutable cap 0.20e18
  quoteCreatorShareWad: '750000000000000000', // 0.75e18, immutable cap 0.90e18
  tokenMilestoneFundShareWad: '200000000000000000', // 0.20e18, immutable cap 0.50e18
  version: 1n,
} as const;

export const ECONOMICS_CAPS = {
  maxHarvestServiceFeeWad: '200000000000000000',
  maxQuoteCreatorShareWad: '900000000000000000',
  maxTokenMilestoneFundShareWad: '500000000000000000',
} as const;

export const POOL_TICK_SPACING = 1;
export const MAX_DEV_BUY_SHARE_WAD = '100000000000000000'; // 0.1e18
export const FULL_RANGE_TICK_BOUND = 880_000;
export const FLUSH_TIP_BPS = 100; // floor 1% of a newly redeemed pot
export const WAD = 1_000_000_000_000_000_000n;
export const FEE_DENOMINATOR = 1_000_000n;
export const MAX_BAND_COUNT = 256;

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
  'LaunchConfig(address creator,string name,string symbol,uint256 totalSupply,uint64 devBuyShareWad,uint256 payoutPlan,uint256 deadline)';

export const LAUNCH_CONFIG_FIELD_ORDER = [
  'creator',
  'name',
  'symbol',
  'totalSupply',
  'devBuyShareWad',
  'payoutPlan',
  'deadline',
] as const;

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
