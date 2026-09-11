import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { buildAddressBook } from '../src/infrastructure/blockchain/address-book';

/**
 * manifest:sync — loads the deployment manifest (deployments/<chainId>.json or the
 * SPAWN_*_ADDRESS environment overrides) into the `deployment_manifests` table.
 *
 * Usage:
 *   yarn manifest:sync [chainId] [manifestPath]
 *
 * Runs without the Nest DI graph so it works directly under tsx/node.
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const chainId = Number(args[0] ?? process.env.DEFAULT_CHAIN_ID ?? 8453);
  const defaultPath = resolve('spawn-integration-handoff', 'deployments', `${chainId}.json`);
  const manifestPath = args[1] ?? defaultPath;

  let document: unknown;
  if (existsSync(manifestPath)) {
    document = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } else {
    // No manifest file yet: pass undefined so environment overrides drive the
    // address book, then persist the resolved result as the canonical document.
    document = undefined;
  }

  // Validate through the address book builder (env overrides win over the file).
  const book = buildAddressBook(chainId, document);
  const canonical = Object.fromEntries(
    Object.entries({
      chainId,
      hook: book.hook,
      launchSupport: book.launchSupport,
      revenueNft: book.revenueNft,
      payoutPluginRegistry: book.payoutPluginRegistry,
      protocolController: book.protocolController,
      poolManager: book.poolManager,
      stateView: book.stateView,
      v4Quoter: book.v4Quoter,
      multicall3: book.multicall3,
      buybackAndBurnPlugin: book.buybackAndBurnPlugin,
      canonicalPayoutPlan: book.canonicalPayoutPlan,
      hookSalt: book.hookSalt,
    }).filter(([, value]) => value !== undefined && value !== null),
  );

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const adapter = new PrismaPg(new Client({ connectionString }));
  const prisma = new PrismaClient({ adapter });
  try {
    await prisma.deploymentManifest.upsert({
      where: { chainId },
      create: { chainId, document: canonical },
      update: { document: canonical },
    });
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `manifest synced for chain ${chainId}: hook=${book.hook} poolManager=${book.poolManager}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
