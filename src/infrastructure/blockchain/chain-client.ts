import {
  createPublicClient,
  fallback,
  http,
  type PublicClient,
  type FallbackTransport,
  type HttpTransport,
  type Chain,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';

/**
 * viem public client factory per chain. RPC endpoints are configured via
 * environment (comma-separated list for fallback transport) and must be archival-grade
 * for the indexer's historical range queries.
 */

const chainById: Record<number, Chain> = {
  8453: base,
  84532: baseSepolia,
};

export function chainDefinition(chainId: number): Chain {
  const chain = chainById[chainId];
  if (chain) return chain;
  // Unknown chain: build a minimal definition so viem can still format/route RPC.
  return {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [] } },
  };
}

export function httpTransportsForChain(chainId: number, rpcUrls: string[]): HttpTransport[] {
  return rpcUrls
    .filter((url) => url.trim().length > 0)
    .map((url) => http(url.trim(), { timeout: 30_000, batch: { wait: 16 } }));
}

export function createChainPublicClient(
  chainId: number,
  rpcUrls: string[],
): PublicClient<FallbackTransport<HttpTransport[]>> {
  const transports = httpTransportsForChain(chainId, rpcUrls);
  if (transports.length === 0) {
    throw new Error(`No RPC endpoints configured for chain ${chainId}. Set CHAIN_RPC_URLS.`);
  }
  return createPublicClient({
    chain: chainDefinition(chainId),
    transport: fallback(transports, { rank: false }),
  });
}
