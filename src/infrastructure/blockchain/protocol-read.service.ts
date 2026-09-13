import { Injectable, Logger } from '@nestjs/common';
import type { Address } from 'viem';
import { BlockchainRegistryService } from './blockchain-registry.service';
import { ChainClientFactory } from './chain-client.factory';
import {
  MILESTONE_HOOK_ABI,
  PAYOUT_PLUGIN_REGISTRY_ABI,
  PROTOCOL_CONTROLLER_ABI,
  STATE_VIEW_ABI,
} from './contract-abis';

/**
 * Read helpers over the protocol contracts with caching: template, economics,
 * registry, pool state, slot0, claimables, governance state. Cache TTLs are short
 * so the indexer/API stay close to chain head.
 */

const TEMPLATE_TTL_MS = 5 * 60 * 1000;
const ECONOMICS_TTL_MS = 30 * 1000;
const POOL_STATE_TTL_MS = 5 * 1000;
const SLOT0_TTL_MS = 2 * 1000;
const CONTROLLER_TTL_MS = 30 * 1000;

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
  private controllerCache?: { value: ControllerStateView; expiresAt: number };

  constructor(
    private readonly registry: BlockchainRegistryService,
    private readonly clientFactory: ChainClientFactory,
  ) {}

  private hookRead<T>(
    chainId: number,
    functionName: string,
    args?: readonly unknown[],
  ): Promise<T> {
    const book = this.registry.book(chainId);
    return this.clientFactory.client(chainId).readContract({
      address: book.hook as Address,
      abi: MILESTONE_HOOK_ABI,
      functionName,
      ...(args && args.length > 0 ? { args } : {}),
    }) as Promise<T>;
  }

  private registryRead<T>(
    chainId: number,
    functionName: string,
    args?: readonly unknown[],
  ): Promise<T> {
    const book = this.registry.book(chainId);
    return this.clientFactory.client(chainId).readContract({
      address: book.payoutPluginRegistry as Address,
      abi: PAYOUT_PLUGIN_REGISTRY_ABI,
      functionName,
      ...(args && args.length > 0 ? { args } : {}),
    }) as Promise<T>;
  }

  private controllerRead<T>(
    chainId: number,
    functionName: string,
    args?: readonly unknown[],
  ): Promise<T> {
    const book = this.registry.book(chainId);
    return this.clientFactory.client(chainId).readContract({
      address: book.protocolController as Address,
      abi: PROTOCOL_CONTROLLER_ABI,
      functionName,
      ...(args && args.length > 0 ? { args } : {}),
    }) as Promise<T>;
  }

  async template(chainId: number): Promise<ProtocolTemplateView> {
    const cached = this.templateCache.get(chainId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.hookRead<ProtocolTemplateView>(chainId, 'template');
    this.templateCache.set(chainId, { value, expiresAt: Date.now() + TEMPLATE_TTL_MS });
    return value;
  }

  async economicConfig(chainId: number): Promise<EconomicConfigView> {
    const cached = this.economicsCache.get(chainId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.hookRead<EconomicConfigView>(chainId, 'economicConfig');
    this.economicsCache.set(chainId, { value, expiresAt: Date.now() + ECONOMICS_TTL_MS });
    return value;
  }

  async poolState(chainId: number, poolId: string): Promise<PoolStateView> {
    const key = `${chainId}:${poolId}`;
    const cached = this.poolStateCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.hookRead<PoolStateView>(chainId, 'poolState', [poolId]);
    this.poolStateCache.set(key, { value, expiresAt: Date.now() + POOL_STATE_TTL_MS });
    return value;
  }

  async slot0(chainId: number, poolId: string): Promise<Slot0View | null> {
    const book = this.registry.book(chainId);
    if (!book.stateView) return null;
    const key = `${chainId}:${poolId}`;
    const cached = this.slot0Cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    // getSlot0 returns multiple top-level outputs, which viem surfaces as a
    // positional array (not a named object like struct returns).
    const raw = (await this.clientFactory.client(chainId).readContract({
      address: book.stateView as Address,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [poolId as `0x${string}`],
    })) as unknown as readonly [bigint, number, number, number] | Slot0View;
    const value: Slot0View = Array.isArray(raw)
      ? { sqrtPriceX96: raw[0], tick: Number(raw[1]), protocolFee: Number(raw[2]), lpFee: Number(raw[3]) }
      : (raw as Slot0View);
    this.slot0Cache.set(key, { value, expiresAt: Date.now() + SLOT0_TTL_MS });
    return value;
  }

  async registryEntry(chainId: number, index: number): Promise<PluginEntryView> {
    return await this.registryRead<PluginEntryView>(chainId, 'entry', [index]);
  }

  async registryEntryCount(chainId: number): Promise<number> {
    const value = await this.registryRead<bigint>(chainId, 'entryCount');
    return Number(value);
  }

  /** Governance state + the live ACTION_* constants (so event action bytes decode to names). */
  async controllerState(chainId: number): Promise<ControllerStateView> {
    if (this.controllerCache && this.controllerCache.expiresAt > Date.now())
      return this.controllerCache.value;
    const [
      administrator,
      pendingAdministrator,
      governanceDelay,
      protocolRecipient,
      trustedOperator,
      e,
      r,
      p,
      s,
      g,
    ] = await Promise.all([
      this.controllerRead<string>(chainId, 'administrator'),
      this.controllerRead<string>(chainId, 'pendingAdministrator'),
      this.controllerRead<bigint>(chainId, 'governanceDelay'),
      this.controllerRead<string>(chainId, 'protocolRecipient'),
      this.hookRead<string>(chainId, 'trustedOperator'),
      this.controllerRead<bigint>(chainId, 'ACTION_SET_ECONOMIC_CONFIG'),
      this.controllerRead<bigint>(chainId, 'ACTION_SET_PROTOCOL_RECIPIENT'),
      this.controllerRead<bigint>(chainId, 'ACTION_REGISTER_PLUGIN'),
      this.controllerRead<bigint>(chainId, 'ACTION_SET_PLUGIN_SUSPENDED'),
      this.controllerRead<bigint>(chainId, 'ACTION_SET_DELAY'),
    ]);
    const setOp = await this.controllerRead<bigint>(chainId, 'ACTION_SET_TRUSTED_OPERATOR');
    const value: ControllerStateView = {
      administrator: administrator.toLowerCase(),
      pendingAdministrator: pendingAdministrator.toLowerCase(),
      governanceDelay,
      protocolRecipient: protocolRecipient.toLowerCase(),
      trustedOperator: trustedOperator.toLowerCase(),
      actions: {
        [Number(e)]: 'SET_ECONOMIC_CONFIG',
        [Number(r)]: 'SET_PROTOCOL_RECIPIENT',
        [Number(p)]: 'REGISTER_PLUGIN',
        [Number(s)]: 'SET_PLUGIN_SUSPENDED',
        [Number(g)]: 'SET_GOVERNANCE_DELAY',
        [Number(setOp)]: 'SET_TRUSTED_OPERATOR',
      },
    };
    this.controllerCache = { value, expiresAt: Date.now() + CONTROLLER_TTL_MS };
    return value;
  }

  async creatorClaimable(chainId: number, poolId: string): Promise<bigint> {
    return await this.hookRead<bigint>(chainId, 'creatorClaimable', [poolId]);
  }

  async creatorPathClaimable(chainId: number, poolId: string): Promise<bigint> {
    return await this.hookRead<bigint>(chainId, 'creatorPathClaimable', [poolId]);
  }

  async protocolClaimable(chainId: number): Promise<bigint> {
    return await this.hookRead<bigint>(chainId, 'protocolClaimable');
  }

  async protocolClaimBacked(chainId: number): Promise<bigint> {
    return await this.hookRead<bigint>(chainId, 'protocolClaimBacked');
  }

  async payoutPot(chainId: number, poolId: string): Promise<bigint> {
    return await this.hookRead<bigint>(chainId, 'payoutPot', [poolId]);
  }

  async pluginCarry(chainId: number, poolId: string, pluginIndex: number): Promise<bigint> {
    return await this.hookRead<bigint>(chainId, 'pluginCarry', [poolId, pluginIndex]);
  }

  async carryBitmap(chainId: number, poolId: string): Promise<bigint> {
    return await this.hookRead<bigint>(chainId, 'carryBitmap', [poolId]);
  }

  async flushGasCeiling(chainId: number, poolId: string): Promise<bigint> {
    return await this.hookRead<bigint>(chainId, 'flushGasCeiling', [poolId]);
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

  invalidateGovernance(): void {
    this.controllerCache = undefined;
  }
}

export type ProtocolTemplateView = {
  openingFdvWei: bigint;
  curvePositions: number;
  curveSpanLevels: number;
  bandLevelSpacing: number;
  bandFirstStepLevels: number;
  bandStepDecayLevels: number;
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
  wallLiquidity: bigint;
  wallTickLower: number;
  wallTickUpper: number;
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

export type ControllerStateView = {
  administrator: string;
  pendingAdministrator: string;
  governanceDelay: bigint;
  protocolRecipient: string;
  trustedOperator: string;
  actions: Record<number, string>;
};
