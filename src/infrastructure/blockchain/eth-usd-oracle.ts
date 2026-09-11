import { Injectable, Logger } from '@nestjs/common';
import { ChainClientFactory } from './chain-client.factory';

/**
 * ETH/USD oracle (Chainlink-style AggregatorV3). USD-denominated fields stay null
 * when no oracle is configured — ETH-denominated values are always available.
 */

const AGGREGATOR_V3_ABI = [
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { internalType: 'uint80', name: 'roundId', type: 'uint80' },
      { internalType: 'int256', name: 'answer', type: 'int256' },
      { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
      { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
      { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const CHAINLINK_ETH_USD: Record<number, string> = {
  8453: '0x71041dddad3595F9CEd3Dc856aE90695c7b3E1A7', // Base mainnet ETH/USD
};

const CACHE_TTL_MS = 60_000;

@Injectable()
export class EthUsdOracle {
  private readonly logger = new Logger(EthUsdOracle.name);
  private cache: { chainId: number; value: bigint; fetchedAt: number } | null = null;

  constructor(private readonly clientFactory: ChainClientFactory) {}

  /** Latest ETH/USD as an integer in the aggregator's decimals (typically 8). */
  async ethUsd(chainId: number): Promise<bigint> {
    const cached = this.cache;
    if (cached && cached.chainId === chainId && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.value;
    }
    const configured = process.env.ETH_USD_ORACLE_ADDRESS?.trim();
    const address = configured || CHAINLINK_ETH_USD[chainId];
    if (!address) throw new Error(`no ETH/USD oracle configured for chain ${chainId}`);
    const staleAfter = Number(process.env.ETH_USD_ORACLE_STALE_SECONDS ?? 3600);
    const client = this.clientFactory.client(chainId);
    const data = (await client.readContract({
      address: address as `0x${string}`,
      abi: AGGREGATOR_V3_ABI,
      functionName: 'latestRoundData',
    })) as [bigint, bigint, bigint, bigint, bigint];
    const [, answer, , updatedAt] = data;
    if (answer <= 0n) throw new Error('oracle answer non-positive');
    if (Date.now() / 1000 - Number(updatedAt) > staleAfter) throw new Error('oracle answer stale');
    this.cache = { chainId, value: answer, fetchedAt: Date.now() };
    return answer;
  }
}
