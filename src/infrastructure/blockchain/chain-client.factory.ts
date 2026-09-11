import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { PublicClient } from 'viem';
import { createChainPublicClient } from './chain-client';

/**
 * Creates and caches viem public clients (and clients for auxiliary chains used by
 * the ETH/USD oracle). Indexer and API share this factory.
 */

@Injectable()
export class ChainClientFactory implements OnModuleDestroy {
  private readonly clients = new Map<number, PublicClient>();
  private config?: { chainId: number; rpcUrls: string[] };

  configure(chainId: number, rpcUrls: string[]): void {
    this.config = { chainId, rpcUrls };
  }

  client(chainId: number): PublicClient {
    const cached = this.clients.get(chainId);
    if (cached) return cached;
    const rpcUrls = chainId === this.config?.chainId ? this.config.rpcUrls : [];
    const urls = rpcUrls.length > 0 ? rpcUrls : environmentDefaultUrls(chainId);
    const client = createChainPublicClient(chainId, urls);
    this.clients.set(chainId, client);
    return client;
  }

  onModuleDestroy(): void {
    this.clients.clear();
  }
}

function environmentDefaultUrls(chainId: number): string[] {
  const raw = process.env[`RPC_URLS_${chainId}`];
  if (raw?.trim())
    return raw
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean);
  return [];
}
