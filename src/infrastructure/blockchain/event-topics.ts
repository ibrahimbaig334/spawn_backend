import { toEventSignature, toEventHash } from 'viem';

/**
 * Canonical event topic registry for every indexed event.
 *
 * Topic0 values are keccak256 of the canonical event signatures exactly as declared in
 * the curated ABIs (copied to src/infrastructure/blockchain/abi). Signatures are listed
 * in human form; `toEventSignature` strips the `indexed` markers and `toEventHash`
 * computes topic0.
 */

export type EventContract =
  'hook' | 'registry' | 'controller' | 'revenueNft' | 'token' | 'poolManager';

export type EventTopicEntry = {
  contract: EventContract;
  name: string;
  signature: string;
  topic0: `0x${string}`;
};

const ENTRIES: Array<{ contract: EventContract; name: string; params: string }> = [
  // --- MilestoneHook (26 events) ---
  {
    contract: 'hook',
    name: 'Launched',
    params:
      'bytes32 indexed poolId, address indexed creator, address indexed token, string name, string symbol, string uri, uint256 totalSupply, int24 openingLevel, int24 farLevel, bytes32 configHash',
  },
  {
    contract: 'hook',
    name: 'LaunchConfigured',
    params: 'bytes32 indexed poolId, uint256 payoutPlan, uint64 devBuyShareWad',
  },
  {
    contract: 'hook',
    name: 'DevBuyExecuted',
    params: 'bytes32 indexed poolId, uint256 tokensBought, uint256 ethSpent',
  },
  {
    contract: 'hook',
    name: 'DevBuySkipped',
    params: 'bytes32 indexed poolId, address indexed relayer, uint256 tokensRequested',
  },
  {
    contract: 'hook',
    name: 'CurvePositionsDeployed',
    params: 'bytes32 indexed poolId, uint256 minted, uint32 deployed, uint256 tokenSettled',
  },
  {
    contract: 'hook',
    name: 'BandDeployed',
    params:
      'bytes32 indexed poolId, uint32 indexed index, int24 levelLower, int24 levelUpper, uint128 liquidity, uint256 tokenInventory',
  },
  {
    contract: 'hook',
    name: 'BandSkipped',
    params: 'bytes32 indexed poolId, uint32 indexed index, uint256 carriedInventory',
  },
  {
    contract: 'hook',
    name: 'MilestoneHarvested',
    params:
      'bytes32 indexed poolId, uint32 indexed index, uint256 quoteProceeds, uint256 tokenResidue, uint32 completedMilestones',
  },
  {
    contract: 'hook',
    name: 'Graduated',
    params:
      'bytes32 indexed poolId, int24 graduationLevel, uint256 quoteProceeds, uint256 lpSeedQuote, uint256 creatorQuote, uint256 protocolQuote, uint128 fullRangeLiquidity, uint128 wallLiquidity',
  },
  {
    contract: 'hook',
    name: 'PayoutPotFunded',
    params:
      'bytes32 indexed poolId, uint32 indexed milestoneIndex, uint256 grossQuote, uint256 serviceFee, uint256 netQuote, uint64 economicVersion',
  },
  { contract: 'hook', name: 'PayoutPotRedeemed', params: 'bytes32 indexed poolId, uint256 amount' },
  {
    contract: 'hook',
    name: 'PayoutTipPaid',
    params: 'bytes32 indexed poolId, address indexed recipient, uint256 amount',
  },
  {
    contract: 'hook',
    name: 'PluginPayoutDelivered',
    params:
      'bytes32 indexed poolId, uint8 indexed pluginIndex, address indexed plugin, uint256 currentShare, uint256 previousCarry, uint256 delivered',
  },
  {
    contract: 'hook',
    name: 'PluginPayoutCarried',
    params:
      'bytes32 indexed poolId, uint8 indexed pluginIndex, address indexed plugin, uint256 currentShare, uint256 previousCarry, uint256 carried',
  },
  {
    contract: 'hook',
    name: 'PluginPayoutRedirected',
    params:
      'bytes32 indexed poolId, uint8 indexed pluginIndex, uint256 currentShare, uint256 previousCarry, uint256 redirected',
  },
  {
    contract: 'hook',
    name: 'CreatorPathAccrued',
    params: 'bytes32 indexed poolId, uint256 amount',
  },
  {
    contract: 'hook',
    name: 'CreatorPathClaimed',
    params: 'bytes32 indexed poolId, address indexed holder, uint256 amount',
  },
  {
    contract: 'hook',
    name: 'CreatorPathClaimFailed',
    params: 'bytes32 indexed poolId, address indexed holder, uint256 amount',
  },
  {
    contract: 'hook',
    name: 'CreatorAccrued',
    params: 'bytes32 indexed poolId, uint256 amount, uint8 source, uint64 economicVersion',
  },
  {
    contract: 'hook',
    name: 'CreatorClaimed',
    params: 'bytes32 indexed poolId, address indexed holder, uint256 amount',
  },
  {
    contract: 'hook',
    name: 'ProtocolAccrued',
    params: 'bytes32 indexed poolId, uint256 amount, uint8 source, uint64 economicVersion',
  },
  {
    contract: 'hook',
    name: 'ProtocolClaimed',
    params: 'address indexed recipient, uint256 amount',
  },
  {
    contract: 'hook',
    name: 'FeesCollected',
    params: 'bytes32 indexed poolId, address indexed caller, uint256 quoteFees, uint256 tokenFees',
  },
  {
    contract: 'hook',
    name: 'FeesRouted',
    params:
      'bytes32 indexed poolId, uint256 creatorQuote, uint256 protocolQuote, uint256 divertedToNextBand, uint256 tokensBurned, uint64 economicVersion',
  },
  {
    contract: 'hook',
    name: 'EconomicConfigSet',
    params:
      'uint64 indexed version, uint64 harvestServiceFeeWad, uint64 quoteCreatorShareWad, uint64 tokenMilestoneFundShareWad',
  },
  { contract: 'hook', name: 'ProtocolRecipientSet', params: 'address indexed recipient' },
  { contract: 'hook', name: 'TrustedOperatorSet', params: 'address indexed operator' },

  // --- PayoutPluginRegistry (4) ---
  {
    contract: 'registry',
    name: 'PluginRegistered',
    params:
      'uint8 indexed index, address indexed plugin, uint64 takeWad, uint32 gasLimit, bytes32 codeHash, uint8 role',
  },
  {
    contract: 'registry',
    name: 'PluginSuspensionSet',
    params: 'uint8 indexed index, bool suspended',
  },
  {
    contract: 'registry',
    name: 'AdministratorProposed',
    params: 'address indexed administrator, address indexed pendingAdministrator',
  },
  {
    contract: 'registry',
    name: 'AdministratorAccepted',
    params: 'address indexed previousAdministrator, address indexed administrator',
  },

  // --- ProtocolController (9) ---
  {
    contract: 'controller',
    name: 'AdministratorProposed',
    params: 'address indexed administrator, address indexed pendingAdministrator',
  },
  {
    contract: 'controller',
    name: 'AdministratorAccepted',
    params: 'address indexed previousAdministrator, address indexed administrator',
  },
  {
    contract: 'controller',
    name: 'OperationScheduled',
    params:
      'bytes32 indexed operationId, uint8 indexed action, bytes32 indexed salt, uint64 readyAt',
  },
  { contract: 'controller', name: 'OperationExecuted', params: 'bytes32 indexed operationId' },
  { contract: 'controller', name: 'OperationCancelled', params: 'bytes32 indexed operationId' },
  {
    contract: 'controller',
    name: 'EconomicConfigUpdated',
    params:
      'uint64 indexed version, uint64 harvestServiceFeeWad, uint64 quoteCreatorShareWad, uint64 tokenMilestoneFundShareWad',
  },
  {
    contract: 'controller',
    name: 'ProtocolRecipientUpdated',
    params: 'address indexed previousRecipient, address indexed recipient',
  },
  {
    contract: 'controller',
    name: 'GovernanceDelayUpdated',
    params: 'uint64 previousDelay, uint64 newDelay',
  },
  { contract: 'controller', name: 'ProtocolTargetBound', params: 'address indexed target' },
  {
    contract: 'controller',
    name: 'TrustedOperatorUpdated',
    params: 'address indexed previousOperator, address indexed operator',
  },

  // --- RevenueNFT (4; standard ERC-721 plus MinterSet) ---
  { contract: 'revenueNft', name: 'MinterSet', params: 'address indexed minter' },
  {
    contract: 'revenueNft',
    name: 'Transfer',
    params: 'address indexed from, address indexed to, uint256 indexed tokenId',
  },
  {
    contract: 'revenueNft',
    name: 'Approval',
    params: 'address indexed owner, address indexed approved, uint256 indexed tokenId',
  },
  {
    contract: 'revenueNft',
    name: 'ApprovalForAll',
    params: 'address indexed owner, address indexed operator, bool approved',
  },

  // --- MilestoneToken (2; standard ERC-20) ---
  {
    contract: 'token',
    name: 'Transfer',
    params: 'address indexed from, address indexed to, uint256 value',
  },
  {
    contract: 'token',
    name: 'Approval',
    params: 'address indexed owner, address indexed spender, uint256 value',
  },

  // --- Uniswap v4 PoolManager (3) ---
  {
    contract: 'poolManager',
    name: 'Initialize',
    params:
      'bytes32 indexed poolId, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick',
  },
  {
    contract: 'poolManager',
    name: 'ModifyLiquidity',
    params:
      'bytes32 indexed poolId, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt',
  },
  {
    contract: 'poolManager',
    name: 'Swap',
    params:
      'bytes32 indexed poolId, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 lpFee',
  },
];

export const EVENT_TOPICS: readonly EventTopicEntry[] = ENTRIES.map((entry) => {
  const humanSignature = `${entry.name}(${entry.params})`;
  const canonical = toEventSignature(humanSignature);
  return {
    contract: entry.contract,
    name: entry.name,
    signature: canonical,
    topic0: toEventHash(canonical),
  };
});

const BY_NAME = new Map<string, EventTopicEntry>();
for (const entry of EVENT_TOPICS) {
  if (!BY_NAME.has(entry.name)) BY_NAME.set(entry.name, entry);
}

const BY_TOPIC = new Map<string, EventTopicEntry[]>();
for (const entry of EVENT_TOPICS) {
  const existing = BY_TOPIC.get(entry.topic0) ?? [];
  existing.push(entry);
  BY_TOPIC.set(entry.topic0, existing);
}

export function topicEntries(): readonly EventTopicEntry[] {
  return EVENT_TOPICS;
}

export function topicByName(name: string): EventTopicEntry | undefined {
  return BY_NAME.get(name);
}

export function topicsByContract(contract: EventContract): `0x${string}`[] {
  return EVENT_TOPICS.filter((entry) => entry.contract === contract).map((entry) => entry.topic0);
}

export function entriesByTopic(topic0: string): readonly EventTopicEntry[] {
  return BY_TOPIC.get(topic0.toLowerCase()) ?? [];
}
