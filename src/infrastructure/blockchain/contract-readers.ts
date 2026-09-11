import {
  type Address,
  type PublicClient,
  getContract,
  type GetContractReturnType,
  erc20Abi,
  type Hex,
} from 'viem';
import {
  MILESTONE_HOOK_ABI,
  LAUNCH_SUPPORT_ABI,
  REVENUE_NFT_ABI,
  PAYOUT_PLUGIN_REGISTRY_ABI,
  PROTOCOL_CONTROLLER_ABI,
  STATE_VIEW_ABI,
  V4_QUOTER_ABI,
} from './contract-abis';
import type { AddressBook } from './address-book';

/**
 * Typed contract handles over the address book. Read-only surface only: the backend
 * never submits transactions through these except via the explicitly configured
 * relayer path (which is separate).
 */

export type HookContract = GetContractReturnType<typeof MILESTONE_HOOK_ABI, PublicClient, Address>;
export type LaunchSupportContract = GetContractReturnType<
  typeof LAUNCH_SUPPORT_ABI,
  PublicClient,
  Address
>;
export type RevenueNftContract = GetContractReturnType<
  typeof REVENUE_NFT_ABI,
  PublicClient,
  Address
>;
export type RegistryContract = GetContractReturnType<
  typeof PAYOUT_PLUGIN_REGISTRY_ABI,
  PublicClient,
  Address
>;
export type ControllerContract = GetContractReturnType<
  typeof PROTOCOL_CONTROLLER_ABI,
  PublicClient,
  Address
>;
export type StateViewContract = GetContractReturnType<typeof STATE_VIEW_ABI, PublicClient, Address>;
export type QuoterContract = GetContractReturnType<typeof V4_QUOTER_ABI, PublicClient, Address>;

export type ChainReadContracts = {
  chainId: number;
  hook: HookContract;
  launchSupport: LaunchSupportContract;
  revenueNft: RevenueNftContract;
  registry: RegistryContract;
  controller: ControllerContract;
  stateView?: StateViewContract;
  quoter?: QuoterContract;
};

export function buildReadContracts(client: PublicClient, book: AddressBook): ChainReadContracts {
  return {
    chainId: book.chainId,
    hook: getContract({ address: book.hook as Address, abi: MILESTONE_HOOK_ABI, client }),
    launchSupport: getContract({
      address: book.launchSupport as Address,
      abi: LAUNCH_SUPPORT_ABI,
      client,
    }),
    revenueNft: getContract({ address: book.revenueNft as Address, abi: REVENUE_NFT_ABI, client }),
    registry: getContract({
      address: book.payoutPluginRegistry as Address,
      abi: PAYOUT_PLUGIN_REGISTRY_ABI,
      client,
    }),
    controller: getContract({
      address: book.protocolController as Address,
      abi: PROTOCOL_CONTROLLER_ABI,
      client,
    }),
    stateView: book.stateView
      ? getContract({ address: book.stateView as Address, abi: STATE_VIEW_ABI, client })
      : undefined,
    quoter: book.v4Quoter
      ? getContract({ address: book.v4Quoter as Address, abi: V4_QUOTER_ABI, client })
      : undefined,
  };
}

/** Standard ERC-20 handle for a launch token (name/symbol/decimals/totalSupply reads). */
export function tokenContract(client: PublicClient, address: string) {
  return getContract({ address: address as Address, abi: erc20Abi, client });
}

export type PoolKeyStruct = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export const NATIVE_ETH_PLACEHOLDER = '0x0000000000000000000000000000000000000000' as Address;

/** Builds the canonical Spawn pool key: ETH (currency0) vs token (currency1), static 1% fee, tick spacing 1. */
export function spawnPoolKey(book: AddressBook, token: string): PoolKeyStruct {
  return {
    currency0: NATIVE_ETH_PLACEHOLDER,
    currency1: token as Address,
    fee: 10_000,
    tickSpacing: 1,
    hooks: book.hook as Address,
  };
}

export type { Hex };
