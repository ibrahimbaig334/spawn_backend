import { Injectable, Logger } from '@nestjs/common';
import type { PublicClient } from 'viem';
import type { Prisma, PrismaService } from '../infrastructure/database/prisma.service';
import { ChainClientFactory } from '../infrastructure/blockchain/chain-client.factory';
import { BlockchainRegistryService } from '../infrastructure/blockchain/blockchain-registry.service';

/**
 * Reorg-aware block ingester.
 *
 * The indexer walks the chain head with a confirmation depth (Base reorgs are rare
 * and shallow; the default safe depth of 32 makes finality effectively certain).
 * Every processed block is recorded in `block_receipts` with its parent hash. On
 * detecting a parent-hash mismatch, blocks are rolled back in descending order until
 * the canonical chain is rejoined; rollback deletes every projection row stamped
 * with the rolled-back blocks' version.
 *
 * Versioning: each block gets a monotonic `version` = (max committed version) + 1.
 * Projection rows carry `projectionVersion` of the block that wrote them, and the
 * `chain_watermarks.committedVersion` advances only after a block fully commits.
 * API reads gate on `projectionVersion <= committedVersion` for a stable read cut.
 */

export type IngestedBlock = {
  number: bigint;
  hash: string;
  parentHash: string;
  timestamp: Date;
  transactionCount: number;
};

export type IndexerConfig = {
  chainId: number;
  startBlock: number;
  confirmationBlocks: number;
  blockBatch: number;
  pollMs: number;
  maxReorgDepth: number;
};

@Injectable()
export class BlockIngesterService {
  private readonly logger = new Logger(BlockIngesterService.name);
  private client?: PublicClient;
  private config?: IndexerConfig;
  private version?: bigint;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientFactory: ChainClientFactory,
    private readonly registry: BlockchainRegistryService,
  ) {}

  configure(config: IndexerConfig): void {
    this.config = config;
  }

  private ensureClient(): PublicClient {
    if (!this.client) {
      if (!this.config) throw new Error('BlockIngesterService not configured');
      this.client = this.clientFactory.client(this.config.chainId);
    }
    return this.client;
  }

  /** Loads or initializes the chain cursor. */
  async initializeCursor(): Promise<void> {
    if (!this.config) throw new Error('BlockIngesterService not configured');
    const { chainId, startBlock, confirmationBlocks } = this.config;
    const existing = await this.prisma.chainCursor.findUnique({ where: { chainId } });
    if (!existing) {
      const head = await this.fetchHead();
      const genesis = BigInt(Math.max(startBlock, 0));
      await this.prisma.chainCursor.create({
        data: {
          chainId,
          nextBlock: genesis,
          headBlock: genesis > 0n ? genesis - 1n : 0n,
          headBlockHash: '0x' + '0'.repeat(64),
          headBlockTime: head.timestamp,
          safeDepth: confirmationBlocks,
        },
      });
      this.logger.log(`initialized cursor for chain ${chainId} at block ${genesis}`);
    }
  }

  async loadCursor(): Promise<{ nextBlock: bigint; headBlock: bigint }> {
    if (!this.config) throw new Error('not configured');
    const cursor = await this.prisma.chainCursor.findUnique({
      where: { chainId: this.config.chainId },
    });
    if (!cursor) throw new Error('cursor not initialized');
    return { nextBlock: cursor.nextBlock, headBlock: cursor.headBlock };
  }

  private async fetchHead(): Promise<IngestedBlock> {
    const client = this.ensureClient();
    const blockNumber = await client.getBlockNumber();
    const block = await client.getBlock({ blockNumber });
    return {
      number: blockNumber,
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: new Date(Number(block.timestamp) * 1000),
      transactionCount: block.transactions.length,
    };
  }

  /**
   * Rolls back blocks whose recorded hashes no longer match the canonical chain.
   * Returns the number of rolled-back blocks. `rollbackBlock` is a callback so the
   * projector layer can participate (deleting version-stamped rows).
   */
  async reconcileReorgs(rollbackBlock: (blockNumber: bigint) => Promise<void>): Promise<number> {
    const client = this.ensureClient();
    const cursor = await this.prisma.chainCursor.findUnique({
      where: { chainId: this.config!.chainId },
    });
    if (!cursor) throw new Error('cursor not initialized');

    let rolledBack = 0;
    let headBlock = cursor.headBlock;

    // Walk recorded receipts from head down while they mismatch the canonical chain.
    while (headBlock > 0n) {
      const receipt = await this.prisma.blockReceipt.findUnique({
        where: { chainId_blockNumber: { chainId: this.config!.chainId, blockNumber: headBlock } },
      });
      if (!receipt) break; // no receipt: pre-indexer territory, nothing to roll back

      const canonical = await client.getBlock({ blockNumber: headBlock });
      if (canonical.hash === receipt.blockHash) break; // rejoin point

      if (rolledBack >= this.config!.maxReorgDepth) {
        this.logger.error(
          `reorg deeper than maxReorgDepth (${this.config!.maxReorgDepth}); requiring manual intervention`,
        );
        throw new Error('reorg depth exceeded');
      }

      this.logger.warn(
        `reorg detected at block ${headBlock}: recorded ${receipt.blockHash} != canonical ${canonical.hash}`,
      );
      await this.prisma.$transaction(async (tx) => {
        await rollbackBlock(headBlock);
        await tx.blockReceipt.delete({
          where: { chainId_blockNumber: { chainId: this.config!.chainId, blockNumber: headBlock } },
        });
        await tx.rawChainEvent.deleteMany({
          where: { chainId: this.config!.chainId, blockNumber: headBlock },
        });
      });
      rolledBack += 1;
      headBlock -= 1n;
    }

    if (rolledBack > 0) {
      // Re-anchor the cursor at the rejoin point's parent.
      const parent = headBlock > 0n ? await client.getBlock({ blockNumber: headBlock - 1n }) : null;
      await this.prisma.chainCursor.update({
        where: { chainId: this.config!.chainId },
        data: {
          headBlock: parent ? parent.number : 0n,
          headBlockHash: parent ? parent.hash : '0x' + '0'.repeat(64),
          nextBlock: parent ? parent.number + 1n : 0n,
        },
      });
    }

    return rolledBack;
  }

  /**
   * Fetches the next batch of confirmed blocks from the chain, verifying each
   * block's parent links to the recorded head (reorgs are reconciled first).
   * Returns blocks in ascending order, or an empty array when nothing is new.
   */
  async fetchNextBlocks(): Promise<IngestedBlock[]> {
    const client = this.ensureClient();
    const { chainId, confirmationBlocks, blockBatch } = this.config!;
    const cursor = await this.prisma.chainCursor.findUnique({ where: { chainId } });
    if (!cursor) throw new Error('cursor not initialized');

    const chainHead = await client.getBlockNumber();
    const confirmedHead = chainHead - BigInt(confirmationBlocks);
    if (confirmedHead < cursor.nextBlock) return [];

    const blocks: IngestedBlock[] = [];
    let expectedParent =
      cursor.headBlock > 0n ? await client.getBlock({ blockNumber: cursor.headBlock }) : null;

    for (
      let number = cursor.nextBlock;
      number <= confirmedHead && blocks.length < blockBatch;
      number += 1n
    ) {
      const block = await client.getBlock({ blockNumber: number });
      if (expectedParent && block.parentHash !== expectedParent.hash) {
        // A reorg slipped in between polls; signal the caller to reconcile.
        this.logger.warn(
          `parent mismatch at block ${number}: expected ${expectedParent.parentHash}, got ${block.parentHash}`,
        );
        return blocks.length > 0 ? blocks : [];
      }
      blocks.push({
        number,
        hash: block.hash,
        parentHash: block.parentHash,
        timestamp: new Date(Number(block.timestamp) * 1000),
        transactionCount: block.transactions.length,
      });
      expectedParent = block;
    }

    return blocks;
  }

  /** Next monotonic projection version. */
  async nextVersion(tx: Prisma.TransactionClient): Promise<bigint> {
    if (this.version === undefined) {
      const watermark = await tx.chainWatermark.findUnique({
        where: { chainId: this.config!.chainId },
      });
      this.version = watermark ? watermark.committedVersion : 0n;
    }
    this.version += 1n;
    return this.version;
  }

  /** Commits a fully processed block: receipt, cursor advance, watermark. */
  async commitBlock(
    tx: Prisma.TransactionClient,
    block: IngestedBlock,
    version: bigint,
  ): Promise<void> {
    const chainId = this.config!.chainId;
    await tx.blockReceipt.upsert({
      where: { chainId_blockNumber: { chainId, blockNumber: block.number } },
      create: {
        chainId,
        blockNumber: block.number,
        blockHash: block.hash,
        blockTime: block.timestamp,
        parentHash: block.parentHash,
        transactionCount: block.transactionCount,
        version,
      },
      update: {
        blockHash: block.hash,
        blockTime: block.timestamp,
        parentHash: block.parentHash,
        transactionCount: block.transactionCount,
        version,
      },
    });
    await tx.chainCursor.update({
      where: { chainId },
      data: {
        nextBlock: block.number + 1n,
        headBlock: block.number,
        headBlockHash: block.hash,
        headBlockTime: block.timestamp,
      },
    });
    await tx.chainWatermark.upsert({
      where: { chainId },
      create: {
        chainId,
        committedVersion: version,
        blockNumber: block.number,
        blockHash: block.hash,
        blockTime: block.timestamp,
      },
      update: {
        committedVersion: version,
        blockNumber: block.number,
        blockHash: block.hash,
        blockTime: block.timestamp,
      },
    });
  }

  /**
   * Deletes every fact table row from `blockNumber` forward (facts are the only
   * block-stamped, replay-safe store; state is last-write-wins and gets re-applied
   * by the re-ingest pass). Aggregates are rebuilt once from surviving facts by the
   * caller after the rollback loop completes.
   */
  async rollbackProjections(tx: Prisma.TransactionClient, blockNumber: bigint): Promise<void> {
    const chainId = this.config!.chainId;
    const factTables = [
      'launches',
      'graduations',
      'swaps',
      'curve_deployments',
      'milestone_harvests',
      'harvest_payouts',
      'band_skips',
      'dev_buys',
      'dev_buy_skips',
      'payout_pot_fundings',
      'payout_pot_redemptions',
      'payout_tips',
      'plugin_payouts',
      'creator_accruals',
      'protocol_accruals',
      'creator_path_accruals',
      'claims',
      'creator_path_claim_failures',
      'fee_collections',
      'fee_routings',
      'token_burns',
    ];
    for (const table of factTables) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE "chain_id" = ${chainId} AND "block_number" >= ${blockNumber};`,
      );
    }
    await tx.$executeRawUnsafe(
      `DELETE FROM raw_chain_events WHERE "chain_id" = ${chainId} AND "block_number" >= ${blockNumber};`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM bands WHERE "chain_id" = ${chainId} AND "deployed_block" >= ${blockNumber};`,
    );
  }

  book(): { hook: string; poolManager: string; chainId: number } {
    if (!this.config) throw new Error('not configured');
    const book = this.registry.book(this.config.chainId);
    return { hook: book.hook, poolManager: book.poolManager, chainId: this.config.chainId };
  }
}
