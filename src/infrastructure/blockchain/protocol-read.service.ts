import { Injectable, Logger } from '@nestjs/common';
import { MILESTONE_HOOK_ABI, PAYOUT_PLUGIN_REGISTRY_ABI, STATE_VIEW_ABI } from './contract-abis';
import type { Address } from 'viem';
import { BlockchainRegistryService } from './blockchain-registry.service';
import { ChainClientFactory } from './chain-client.factory';

/**
 * Read helpers over the protocol contracts with caching: template, economics,
 * registry entries, pool state, slot0, claimables. All reads go through
 * client.readContract with the curated ABIs (explicit args, no proxy inference).
 * Cache TTLs are short so the indexer/API stay close to chain head.
 */

const TEMPLATE_TTL_MS = 5 * 60 * 1000;
const ECONOMICS_TTL_MS = 30 * 1000;
const POOL_STATE_TTL_MS = 5 * 1000;
const SLOT0_TTL_MS = 2 * 1000;

@Injectable()
export class ProtocolReadService {
  private readonly logger = new Logger(ProtocolReadService.name);
  private readonly templateCache = new Map<
    number,
    { value: ProtocolTemplateView; expiresAt: number }
  >();
  private readonly economicsCache = new Map<
    number,
    { value: EconomicConfigView; expiresAt: number }
  >();
  private readonly poolStateCache = new Map<string, { value: PoolStateView; expiresAt: number }>();
  private readonly slot0Cache = new Map<string, { value: Slot0View; expiresAt: number }>();

  constructor(
    private readonly registry: BlockchainRegistryService,
    private readonly clientFactory: ChainClientFactory,
  ) {}

  private read<A extends readonly unknown[], R>(
    chainId: number,
    contract: 'hook' | 'registry',
    functionName: string,
    args?: A,
  ): Promise<R> {
    const book = this.registry.book(chainId);
    const address = (contract === 'hook' ? book.hook : book.payoutPluginRegistry) as Address;
    const abi = contract === 'hook' ? MILESTONE_HOOK_ABI : PAYOUT_PLUGIN_REGISTRY_ABI;
    return this.clientFactory.client(chainId).readContract({
      address,
      abi,
      functionName,
      ...(args && args.length > 0 ? { args } : {}),
    }) as Promise<R>;
  }

  async template(chainId: number): Promise<ProtocolTemplateView> {
    const cached = this.templateCache.get(chainId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.read<readonly [], ProtocolTemplateView>(chainId, 'hook', 'template');
    this.templateCache.set(chainId, { value, expiresAt: Date.now() + TEMPLATE_TTL_MS });
    return value;
  }

  async economicConfig(chainId: number): Promise<EconomicConfigView> {
    const cached = this.economicsCache.get(chainId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.read<readonly [], EconomicConfigView>(
      chainId,
      'hook',
      'economicConfig',
    );
    this.economicsCache.set(chainId, { value, expiresAt: Date.now() + ECONOMICS_TTL_MS });
    return value;
  }

  async poolState(chainId: number, poolId: string): Promise<PoolStateView> {
    const key = `${chainId}:${poolId}`;
    const cached = this.poolStateCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.read<readonly [`0x${string}`], PoolStateView>(
      chainId,
      'hook',
      'poolState',
      [poolId as `0x${string}`],
    );
    this.poolStateCache.set(key, { value, expiresAt: Date.now() + POOL_STATE_TTL_MS });
    return value;
  }

  async slot0(chainId: number, poolId: string): Promise<Slot0View | null> {
    const book = this.registry.book(chainId);
    if (!book.stateView) return null;
    const key = `${chainId}:${poolId}`;
    const cached = this.slot0Cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = (await this.clientFactory.client(chainId).readContract({
      address: book.stateView as Address,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [poolId as `0x${string}`],
    })) as Slot0View;
    this.slot0Cache.set(key, { value, expiresAt: Date.now() + SLOT0_TTL_MS });
    return value;
  }

  async registryEntry(chainId: number, index: number): Promise<PluginEntryView> {
    return await this.read(chainId, 'registry', 'entry', [index]);
  }

  async registryEntryCount(chainId: number): Promise<number> {
    const value = await this.read(chainId, 'registry', 'entryCount');
    return Number(value);
  }

  async creatorClaimable(chainId: number, poolId: string): Promise<bigint> {
    return await this.read(chainId, 'hook', 'creatorClaimable', [poolId as `0x${string}`]);
  }

  async creatorPathClaimable(chainId: number, poolId: string): Promise<bigint> {
    return await this.read(chainId, 'hook', 'creatorPathClaimable', [poolId as `0x${string}`]);
  }

  async protocolClaimable(chainId: number): Promise<bigint> {
    return await this.read(chainId, 'hook', 'protocolClaimable');
  }

  async payoutPot(chainId: number, poolId: string): Promise<bigint> {
    return await this.read(chainId, 'hook', 'payoutPot', [poolId as `0x${string}`]);
  }

  async pluginCarry(chainId: number, poolId: string, pluginIndex: number): Promise<bigint> {
    return await this.read(chainId, 'hook', 'pluginCarry', [poolId as `0x${string}`, pluginIndex]);
  }

  async carryBitmap(chainId: number, poolId: string): Promise<bigint> {
    return await this.read(chainId, 'hook', 'carryBitmap', [poolId as `0x${string}`]);
  }

  async flushSignal(chainId: number, poolId: string): Promise<boolean> {
    const [pot, carry] = await Promise.all([
      this.payoutPot(chainId, poolId),
      this.carryBitmap(chainId, poolId),
    ]);
    return pot > 0n || carry !== 0n;
  }

  invalidatePool(chainId: number, poolId: string): void {
    const key = `${chainId}:${poolId}`;
    this.poolStateCache.delete(key);
    this.slot0Cache.delete(key);
  }

  invalidateEconomics(chainId: number): void {
    this.economicsCache.delete(chainId);
  }
}

export type ProtocolTemplateView = {
  openingFdvWei: bigint;
  curvePositions: number;
  curveSpanLevels: number;
  bandLevelSpacing: number;
  bandWidthLevels: number;
  coreBandCount: number;
  maxFeeFundedBands: number;
  curveSupplyShareWad: bigint;
  ladderSupplyShareWad: bigint;
  fullRangeSupplyShareWad: bigint;
  lpSeedWad: bigint;
  proceedsCreatorWad: bigint;
  proceedsProtocolWad: bigint;
  tradingFeeHundredthsBip: number;
  bandInventoryCapMultiple: number;
  maxDeploysPerSwap: number;
  maxHarvestsPerSwap: number;
};

export type EconomicConfigView = {
  harvestServiceFeeWad: bigint;
  quoteCreatorShareWad: bigint;
  tokenMilestoneFundShareWad: bigint;
  version: bigint;
};

export type PoolStateView = {
  phase: number;
  creator: string;
  token: string;
  launchedAt: bigint;
  graduatedAt: bigint;
  totalSupply: bigint;
  openingLevel: number;
  farLevel: number;
  payoutPlan: bigint;
  curveDeployed: number;
  graduationLevel: number;
  deployedBands: bigint;
  completedBands: bigint;
  nextBandIndex: number;
  feeFundedBandsCreated: number;
  completedMilestones: number;
  ladderInventoryRemaining: bigint;
  carriedInventory: bigint;
  milestoneFundAccrued: bigint;
  fullRangeLiquidity: bigint;
  fullRangeTickLower: number;
  fullRangeTickUpper: number;
};

export type Slot0View = {
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
};

export type PluginEntryView = {
  plugin: string;
  takeWad: bigint;
  gasLimit: number;
  codeHash: string;
  role: number;
  suspended: boolean;
};
