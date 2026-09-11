import { type Log, decodeEventLog } from 'viem';
import { MILESTONE_HOOK_ABI } from '../infrastructure/blockchain/contract-abis';
import { topicByName } from '../infrastructure/blockchain/event-topics';

/**
 * Decodes raw logs into typed protocol events using the curated hook ABI. Only
 * events emitted by the configured hook (or PoolManager, ERC20 tokens, NFT) with a
 * known topic0 are decoded; unknown topics are stored verbatim in the raw ledger.
 */

export type DecodedHookEvent =
  | {
      name: 'Launched';
      poolId: string;
      creator: string;
      token: string;
      totalSupply: bigint;
      openingLevel: number;
      farLevel: number;
      configHash: string;
    }
  | { name: 'LaunchConfigured'; poolId: string; payoutPlan: bigint; devBuyShareWad: bigint }
  | { name: 'DevBuyExecuted'; poolId: string; tokensBought: bigint; ethSpent: bigint }
  | { name: 'DevBuySkipped'; poolId: string; relayer: string; tokensRequested: bigint }
  | {
      name: 'CurvePositionsDeployed';
      poolId: string;
      minted: bigint;
      deployed: number;
      tokenSettled: bigint;
    }
  | {
      name: 'BandDeployed';
      poolId: string;
      index: number;
      levelLower: number;
      levelUpper: number;
      liquidity: bigint;
      tokenInventory: bigint;
    }
  | { name: 'BandSkipped'; poolId: string; index: number; carriedInventory: bigint }
  | {
      name: 'MilestoneHarvested';
      poolId: string;
      index: number;
      quoteProceeds: bigint;
      tokenResidue: bigint;
      completedMilestones: number;
    }
  | {
      name: 'Graduated';
      poolId: string;
      graduationLevel: number;
      quoteProceeds: bigint;
      lpSeedQuote: bigint;
      creatorQuote: bigint;
      protocolQuote: bigint;
      fullRangeLiquidity: bigint;
    }
  | {
      name: 'PayoutPotFunded';
      poolId: string;
      milestoneIndex: number;
      grossQuote: bigint;
      serviceFee: bigint;
      netQuote: bigint;
      economicVersion: bigint;
    }
  | { name: 'PayoutPotRedeemed'; poolId: string; amount: bigint }
  | { name: 'PayoutTipPaid'; poolId: string; flusher: string; amount: bigint }
  | {
      name: 'PluginPayoutDelivered';
      poolId: string;
      pluginIndex: number;
      plugin: string;
      currentShare: bigint;
      previousCarry: bigint;
      delivered: bigint;
    }
  | {
      name: 'PluginPayoutCarried';
      poolId: string;
      pluginIndex: number;
      plugin: string;
      currentShare: bigint;
      previousCarry: bigint;
      carried: bigint;
    }
  | {
      name: 'PluginPayoutRedirected';
      poolId: string;
      pluginIndex: number;
      currentShare: bigint;
      previousCarry: bigint;
      redirected: bigint;
    }
  | { name: 'CreatorPathAccrued'; poolId: string; amount: bigint }
  | { name: 'CreatorPathClaimed'; poolId: string; holder: string; amount: bigint }
  | { name: 'CreatorPathClaimFailed'; poolId: string; holder: string; amount: bigint }
  | {
      name: 'CreatorAccrued';
      poolId: string;
      amount: bigint;
      source: number;
      economicVersion: bigint;
    }
  | { name: 'CreatorClaimed'; poolId: string; holder: string; amount: bigint }
  | {
      name: 'ProtocolAccrued';
      poolId: string;
      amount: bigint;
      source: number;
      economicVersion: bigint;
    }
  | { name: 'ProtocolClaimed'; recipient: string; amount: bigint }
  | { name: 'FeesCollected'; poolId: string; caller: string; quoteFees: bigint; tokenFees: bigint }
  | {
      name: 'FeesRouted';
      poolId: string;
      creatorQuote: bigint;
      protocolQuote: bigint;
      divertedToNextBand: bigint;
      tokensBurned: bigint;
      economicVersion: bigint;
    }
  | {
      name: 'EconomicConfigSet';
      version: bigint;
      harvestServiceFeeWad: bigint;
      quoteCreatorShareWad: bigint;
      tokenMilestoneFundShareWad: bigint;
    }
  | { name: 'ProtocolRecipientSet'; recipient: string };

export type DecodedPoolManagerEvent =
  | {
      name: 'Initialize';
      poolId: string;
      currency0: string;
      currency1: string;
      fee: number;
      tickSpacing: number;
      hooks: string;
      sqrtPriceX96: bigint;
      tick: number;
    }
  | {
      name: 'ModifyLiquidity';
      poolId: string;
      sender: string;
      tickLower: number;
      tickUpper: number;
      liquidityDelta: bigint;
      salt: string;
    }
  | {
      name: 'Swap';
      poolId: string;
      sender: string;
      amount0: bigint;
      amount1: bigint;
      sqrtPriceX96: bigint;
      liquidity: bigint;
      tick: number;
      lpFee: number;
    };

export function decodeHookEvent(log: Log): DecodedHookEvent | null {
  if (!log.topics[0]) return null;
  const decoded = decodeEventLog({
    abi: MILESTONE_HOOK_ABI,
    data: log.data,
    topics: log.topics,
  }) as unknown as { eventName: string; args: Record<string, unknown> };
  const args = decoded.args as Record<string, bigint | string | number | boolean>;
  switch (decoded.eventName) {
    case 'Launched':
      return {
        name: 'Launched',
        poolId: hex(args.poolId),
        creator: addr(args.creator),
        token: addr(args.token),
        totalSupply: big(args.totalSupply),
        openingLevel: num(args.openingLevel),
        farLevel: num(args.farLevel),
        configHash: hex(args.configHash),
      };
    case 'LaunchConfigured':
      return {
        name: 'LaunchConfigured',
        poolId: hex(args.poolId),
        payoutPlan: big(args.payoutPlan),
        devBuyShareWad: big(args.devBuyShareWad),
      };
    case 'DevBuyExecuted':
      return {
        name: 'DevBuyExecuted',
        poolId: hex(args.poolId),
        tokensBought: big(args.tokensBought),
        ethSpent: big(args.ethSpent),
      };
    case 'DevBuySkipped':
      return {
        name: 'DevBuySkipped',
        poolId: hex(args.poolId),
        relayer: addr(args.relayer),
        tokensRequested: big(args.tokensRequested),
      };
    case 'CurvePositionsDeployed':
      return {
        name: 'CurvePositionsDeployed',
        poolId: hex(args.poolId),
        minted: big(args.minted),
        deployed: num(args.deployed),
        tokenSettled: big(args.tokenSettled),
      };
    case 'BandDeployed':
      return {
        name: 'BandDeployed',
        poolId: hex(args.poolId),
        index: num(args.index),
        levelLower: num(args.levelLower),
        levelUpper: num(args.levelUpper),
        liquidity: big(args.liquidity),
        tokenInventory: big(args.tokenInventory),
      };
    case 'BandSkipped':
      return {
        name: 'BandSkipped',
        poolId: hex(args.poolId),
        index: num(args.index),
        carriedInventory: big(args.carriedInventory),
      };
    case 'MilestoneHarvested':
      return {
        name: 'MilestoneHarvested',
        poolId: hex(args.poolId),
        index: num(args.index),
        quoteProceeds: big(args.quoteProceeds),
        tokenResidue: big(args.tokenResidue),
        completedMilestones: num(args.completedMilestones),
      };
    case 'Graduated':
      return {
        name: 'Graduated',
        poolId: hex(args.poolId),
        graduationLevel: num(args.graduationLevel),
        quoteProceeds: big(args.quoteProceeds),
        lpSeedQuote: big(args.lpSeedQuote),
        creatorQuote: big(args.creatorQuote),
        protocolQuote: big(args.protocolQuote),
        fullRangeLiquidity: big(args.fullRangeLiquidity),
      };
    case 'PayoutPotFunded':
      return {
        name: 'PayoutPotFunded',
        poolId: hex(args.poolId),
        milestoneIndex: num(args.milestoneIndex),
        grossQuote: big(args.grossQuote),
        serviceFee: big(args.serviceFee),
        netQuote: big(args.netQuote),
        economicVersion: big(args.economicVersion),
      };
    case 'PayoutPotRedeemed':
      return { name: 'PayoutPotRedeemed', poolId: hex(args.poolId), amount: big(args.amount) };
    case 'PayoutTipPaid':
      return {
        name: 'PayoutTipPaid',
        poolId: hex(args.poolId),
        flusher: addr(args.flusher),
        amount: big(args.amount),
      };
    case 'PluginPayoutDelivered':
      return {
        name: 'PluginPayoutDelivered',
        poolId: hex(args.poolId),
        pluginIndex: num(args.pluginIndex),
        plugin: addr(args.plugin),
        currentShare: big(args.currentShare),
        previousCarry: big(args.previousCarry),
        delivered: big(args.delivered),
      };
    case 'PluginPayoutCarried':
      return {
        name: 'PluginPayoutCarried',
        poolId: hex(args.poolId),
        pluginIndex: num(args.pluginIndex),
        plugin: addr(args.plugin),
        currentShare: big(args.currentShare),
        previousCarry: big(args.previousCarry),
        carried: big(args.carried),
      };
    case 'PluginPayoutRedirected':
      return {
        name: 'PluginPayoutRedirected',
        poolId: hex(args.poolId),
        pluginIndex: num(args.pluginIndex),
        currentShare: big(args.currentShare),
        previousCarry: big(args.previousCarry),
        redirected: big(args.redirected),
      };
    case 'CreatorPathAccrued':
      return { name: 'CreatorPathAccrued', poolId: hex(args.poolId), amount: big(args.amount) };
    case 'CreatorPathClaimed':
      return {
        name: 'CreatorPathClaimed',
        poolId: hex(args.poolId),
        holder: addr(args.holder),
        amount: big(args.amount),
      };
    case 'CreatorPathClaimFailed':
      return {
        name: 'CreatorPathClaimFailed',
        poolId: hex(args.poolId),
        holder: addr(args.holder),
        amount: big(args.amount),
      };
    case 'CreatorAccrued':
      return {
        name: 'CreatorAccrued',
        poolId: hex(args.poolId),
        amount: big(args.amount),
        source: num(args.source),
        economicVersion: big(args.economicVersion),
      };
    case 'CreatorClaimed':
      return {
        name: 'CreatorClaimed',
        poolId: hex(args.poolId),
        holder: addr(args.holder),
        amount: big(args.amount),
      };
    case 'ProtocolAccrued':
      return {
        name: 'ProtocolAccrued',
        poolId: hex(args.poolId),
        amount: big(args.amount),
        source: num(args.source),
        economicVersion: big(args.economicVersion),
      };
    case 'ProtocolClaimed':
      return { name: 'ProtocolClaimed', recipient: addr(args.recipient), amount: big(args.amount) };
    case 'FeesCollected':
      return {
        name: 'FeesCollected',
        poolId: hex(args.poolId),
        caller: addr(args.caller),
        quoteFees: big(args.quoteFees),
        tokenFees: big(args.tokenFees),
      };
    case 'FeesRouted':
      return {
        name: 'FeesRouted',
        poolId: hex(args.poolId),
        creatorQuote: big(args.creatorQuote),
        protocolQuote: big(args.protocolQuote),
        divertedToNextBand: big(args.divertedToNextBand),
        tokensBurned: big(args.tokensBurned),
        economicVersion: big(args.economicVersion),
      };
    case 'EconomicConfigSet':
      return {
        name: 'EconomicConfigSet',
        version: big(args.version),
        harvestServiceFeeWad: big(args.harvestServiceFeeWad),
        quoteCreatorShareWad: big(args.quoteCreatorShareWad),
        tokenMilestoneFundShareWad: big(args.tokenMilestoneFundShareWad),
      };
    case 'ProtocolRecipientSet':
      return { name: 'ProtocolRecipientSet', recipient: addr(args.recipient) };
    default:
      return null;
  }
}

function hex(value: unknown): string {
  return String(value).toLowerCase();
}

function addr(value: unknown): string {
  return String(value).toLowerCase();
}

function big(value: unknown): bigint {
  return value as bigint;
}

function num(value: unknown): number {
  return Number(value);
}

export function hookTopicSet(): `0x${string}`[] {
  return MILESTONE_HOOK_ABI.filter((entry) => entry.type === 'event')
    .map((entry) => topicByName((entry as { name: string }).name)?.topic0)
    .filter((t): t is `0x${string}` => Boolean(t));
}
