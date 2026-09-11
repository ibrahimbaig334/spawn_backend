import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { buildAddressBook, type AddressBook } from './address-book';
import { buildReadContracts, type ChainReadContracts } from './contract-readers';
import { ChainClientFactory } from './chain-client.factory';

/**
 * Central registry of deployment-manifest-backed address books and typed read
 * contracts per chain. The manifest itself is stored in the `deployment_manifests`
 * table (populated by the `manifest:sync` script reading deployments/<chainId>.json)
 * and environment overrides win over the stored manifest.
 */

@Injectable()
export class BlockchainRegistryService implements OnModuleInit {
  private readonly books = new Map<number, AddressBook>();
  private readonly contracts = new Map<number, ChainReadContracts>();
  private configured = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientFactory: ChainClientFactory,
  ) {}

  configure(chainId: number, rpcUrls: string[]): void {
    this.clientFactory.configure(chainId, rpcUrls);
    this.configured = true;
  }

  async onModuleInit(): Promise<void> {
    if (!this.configured) {
      // Default wiring from environment at boot.
      const chainId = Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
      const rpcUrls = (process.env.CHAIN_RPC_URLS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      this.configure(chainId, rpcUrls);
    }
    try {
      await this.loadAll();
    } catch {
      // No manifests yet (pre-deployment): registry stays empty and services degrade.
    }
  }

  private async loadAll(): Promise<void> {
    const manifests = await this.prisma.deploymentManifest.findMany();
    for (const manifest of manifests) {
      try {
        const book = buildAddressBook(manifest.chainId, manifest.document);
        this.books.set(manifest.chainId, book);
      } catch {
        // Skip invalid stored manifests; they are surfaced by the manifest:sync script.
      }
    }
  }

  hasChain(chainId: number): boolean {
    return this.books.has(chainId);
  }

  book(chainId: number): AddressBook {
    const book = this.books.get(chainId);
    if (!book) {
      throw new Error(
        `No address book for chain ${chainId}. Sync the deployment manifest or set SPAWN_*_ADDRESS overrides.`,
      );
    }
    return book;
  }

  contractsFor(chainId: number): ChainReadContracts {
    const cached = this.contracts.get(chainId);
    if (cached) return cached;
    const book = this.book(chainId);
    const built = buildReadContracts(this.clientFactory.client(chainId), book);
    this.contracts.set(chainId, built);
    return built;
  }

  chains(): number[] {
    return [...this.books.keys()];
  }

  async reload(): Promise<void> {
    await this.loadAll();
  }
}
