import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { PublicClient, Log } from 'viem';
import { decodeEventLog, erc20Abi } from 'viem';
import { Prisma, type PrismaService } from '../infrastructure/database/prisma.service';
import { ChainClientFactory } from '../infrastructure/blockchain/chain-client.factory';
import { BlockchainRegistryService } from '../infrastructure/blockchain/blockchain-registry.service';
import { ProtocolReadService } from '../infrastructure/blockchain/protocol-read.service';
import { topicsByContract } from '../infrastructure/blockchain/event-topics';
import {
  PAYOUT_PLUGIN_REGISTRY_ABI,
  PROTOCOL_CONTROLLER_ABI,
  REVENUE_NFT_ABI,
} from '../infrastructure/blockchain/contract-abis';
import { BlockIngesterService, type IndexerConfig } from './block-ingester.service';
import { ProjectionApplier, type ProjectorContext } from './projection-applier';
import { MarketProjector } from './market-projector';
import { decodeHookEvent, type DecodedHookEvent } from './event-decoder';

/**
 * The indexer orchestrator: polls confirmed blocks, fetches filtered logs (hook,
 * PoolManager, tracked tokens, RevenueNFT, registry, controller), decodes, and
 * applies projections atomically per block. Reorgs roll back via the ingester.
 */

@Injectable()
export class IndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopping = false;
  private config?: IndexerConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientFactory: ChainClientFactory,
    private readonly registry: BlockchainRegistryService,
    private readonly protocolReads: ProtocolReadService,
    private readonly ingester: BlockIngesterService,
    private readonly applier: ProjectionApplier,
    private readonly market: MarketProjector,
  ) {}

  configure(config: IndexerConfig): void {
    this.config = config;
    this.ingester.configure(config);
    this.registry.configure(config.chainId, []);
  }

  async onModuleInit(): Promise<void> {
    // The indexer entrypoint calls configure() explicitly; the module hook is a
    // no-op so the same module can be imported by tests.
  }

  onModuleDestroy(): void {
    this.stop();
  }

  async start(): Promise<void> {
    if (!this.config) throw new Error('IndexerService not configured');
    if (!this.registry.hasChain(this.config.chainId)) {
      throw new Error(
        `No address book for chain ${this.config.chainId}. Run manifest:sync or set SPAWN_*_ADDRESS overrides.`,
      );
    }
    await this.ingester.initializeCursor();
    await this.bootBackfill();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollMs);
    this.timer.unref?.();
    this.logger.log(`indexer started on chain ${this.config.chainId}`);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll iteration: reconcile reorgs, ingest a batch of blocks. */
  async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const rolledBack = await this.ingester.reconcileReorgs(async (blockNumber) => {
        await this.prisma.$transaction(async (tx) => {
          await this.ingester.rollbackProjections(tx, blockNumber);
        });
      });
      if (rolledBack > 0) {
        this.logger.warn(`rolled back ${rolledBack} blocks after reorg`);
      }

      const blocks = await this.ingester.fetchNextBlocks();
      for (const block of blocks) {
        await this.ingestBlock(block);
      }
    } catch (error) {
      this.logger.error(`indexer tick failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Ingests one block: fetch logs, decode, project, commit. */
  private async ingestBlock(block: {
    number: bigint;
    hash: string;
    parentHash: string;
    timestamp: Date;
    transactionCount: number;
  }): Promise<void> {
    const chainId = this.config!.chainId;
    const book = this.registry.book(chainId);
    const client = this.clientFactory.client(chainId);

    const logs = await client.getLogs({
      fromBlock: block.number,
      toBlock: block.number,
    });

    await this.prisma.$transaction(
      async (tx) => {
        const version = await this.ingester.nextVersion(tx);
        const ctx: ProjectorContext = {
          chainId,
          blockNumber: block.number,
          blockTime: block.timestamp,
          blockHash: block.hash,
          version,
          txHash: '',
          logIndex: 0,
          hookAddress: book.hook,
          poolManagerAddress: book.poolManager,
        };

        // Pass 1: raw ledger + hook events (in log order).
        for (const log of logs) {
          ctx.txHash = log.transactionHash ?? '';
          ctx.logIndex = log.logIndex;
          await tx.rawChainEvent
            .create({
              data: {
                chainId,
                blockNumber: block.number,
                logIndex: log.logIndex,
                transactionIndex: log.transactionIndex ?? 0,
                transactionHash: log.transactionHash ?? '',
                address: log.address.toLowerCase(),
                topic0: (log.topics[0] ?? '').toLowerCase(),
                topics: log.topics.map((t) => t.toLowerCase()),
                data: log.data.length > 8192 ? log.data.slice(0, 8192) : log.data,
                eventName: null,
                blockHash: block.hash,
                blockTime: block.timestamp,
              },
            })
            .catch((error) => {
              // Duplicate logIndex (shouldn't happen on a canonical block); ignore.
              this.logger.warn(`rawChainEvent insert skipped: ${(error as Error).message}`);
            });

          if (log.address.toLowerCase() !== book.hook.toLowerCase()) continue;
          if (!log.topics[0]) continue;
          const decoded = this.tryDecodeHookEvent(log);
          if (decoded) {
            await this.applier.applyHookEvent(tx, ctx, decoded);
            await tx.rawChainEvent
              .update({
                where: {
                  chainId_blockNumber_logIndex: {
                    chainId,
                    blockNumber: block.number,
                    logIndex: log.logIndex,
                  },
                },
                data: { eventName: decoded.name },
              })
              .catch(() => undefined);
          }
        }

        // Pass 2: PoolManager swaps for pools we know (after Launched processed).
        for (const log of logs) {
          if (log.address.toLowerCase() !== book.poolManager.toLowerCase()) continue;
          ctx.txHash = log.transactionHash ?? '';
          ctx.logIndex = log.logIndex;
          await this.applyPoolManagerLog(tx, ctx, client, log);
        }

        // Pass 3: ERC-20 transfers on tracked tokens + RevenueNFT transfers.
        for (const log of logs) {
          ctx.txHash = log.transactionHash ?? '';
          ctx.logIndex = log.logIndex;
          const address = log.address.toLowerCase();
          if (address === book.revenueNft.toLowerCase()) {
            await this.applyRevenueNftLog(tx, ctx, log);
          } else {
            const tracked = await tx.tokenChainState.findUnique({
              where: { chainId_contractAddress: { chainId, contractAddress: address } },
              select: { tokenId: true },
            });
            if (tracked) {
              await this.applyTokenTransferLog(tx, ctx, address, log);
            }
          }
        }

        // Pass 4: registry + controller governance events.
        for (const log of logs) {
          const address = log.address.toLowerCase();
          ctx.txHash = log.transactionHash ?? '';
          ctx.logIndex = log.logIndex;
          if (address === book.payoutPluginRegistry.toLowerCase()) {
            await this.applyRegistryLog(tx, ctx, log);
          } else if (address === book.protocolController.toLowerCase()) {
            await this.applyControllerLog(tx, ctx, log);
          }
        }

        await this.ingester.commitBlock(tx, block, version);
      },
      { timeout: 120_000, isolationLevel: 'Serializable' },
    );

    this.logger.debug(`ingested block ${block.number} (${logs.length} logs, version applied)`);
  }

  private tryDecodeHookEvent(log: Log): DecodedHookEvent | null {
    try {
      return decodeHookEvent(log);
    } catch {
      return null;
    }
  }

  private async applyPoolManagerLog(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    ctx: ProjectorContext,
    client: PublicClient,
    log: Log,
  ): Promise<void> {
    if (!log.topics[0]) return;
    const swapTopic = topicsByContract('poolManager').find(() => true); // Swap only matters here
    void swapTopic;
    try {
      const decoded = decodeEventLog({
        abi: [
          {
            type: 'event',
            name: 'Swap',
            inputs: [
              { type: 'bytes32', name: 'poolId', indexed: true },
              { type: 'address', name: 'sender', indexed: true },
              { type: 'int128', name: 'amount0', indexed: false },
              { type: 'int128', name: 'amount1', indexed: false },
              { type: 'uint160', name: 'sqrtPriceX96', indexed: false },
              { type: 'uint128', name: 'liquidity', indexed: false },
              { type: 'int24', name: 'tick', indexed: false },
              { type: 'uint24', name: 'lpFee', indexed: false },
            ],
            anonymous: false,
          },
        ],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== 'Swap') return;
      const args = decoded.args as unknown as {
        poolId: `0x${string}`;
        sender: string;
        amount0: bigint;
        amount1: bigint;
        sqrtPriceX96: bigint;
        liquidity: bigint;
        tick: number;
        lpFee: number;
      };
      const poolId = String(args.poolId).toLowerCase();

      // Resolve the trader: the PoolManager Swap.sender is the router/executor; the
      // actual trader is the transaction's sender (tx.from), which we resolve lazily.
      const trader = await this.resolveTxSender(client, log.transactionHash);
      await this.market.applySwap(
        tx,
        { ...ctx, traderWallet: trader },
        {
          name: 'Swap',
          poolId,
          sender: String(args.sender).toLowerCase(),
          amount0: args.amount0,
          amount1: args.amount1,
          sqrtPriceX96: args.sqrtPriceX96,
          liquidity: args.liquidity,
          tick: args.tick,
          lpFee: args.lpFee,
        },
      );
    } catch {
      // Not a Swap event or decode failed; the raw ledger already has it.
    }
  }

  private txSenders = new Map<string, string>();

  private async resolveTxSender(
    client: PublicClient,
    txHash: `0x${string}` | null | undefined,
  ): Promise<string | null> {
    if (!txHash) return null;
    const cached = this.txSenders.get(txHash);
    if (cached !== undefined) return cached;
    try {
      const tx = await client.getTransaction({ hash: txHash });
      this.txSenders.set(txHash, tx.from.toLowerCase());
      if (this.txSenders.size > 10_000) {
        const first = this.txSenders.keys().next().value;
        if (first) this.txSenders.delete(first);
      }
      return tx.from.toLowerCase();
    } catch {
      return null;
    }
  }

  private async applyTokenTransferLog(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    ctx: ProjectorContext,
    token: string,
    log: Log,
  ): Promise<void> {
    if (!log.topics[0]) return;
    try {
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (decoded.eventName !== 'Transfer') return;
      const args = decoded.args as unknown as { from: string; to: string; value: bigint };
      await this.market.applyTokenTransfer(tx, ctx, {
        token,
        from: args.from.toLowerCase(),
        to: args.to.toLowerCase(),
        value: args.value,
      });
    } catch {
      // ignore
    }
  }

  private async applyRevenueNftLog(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    ctx: ProjectorContext,
    log: Log,
  ): Promise<void> {
    if (!log.topics[0]) return;
    try {
      const decoded = decodeEventLog({
        abi: REVENUE_NFT_ABI,
        data: log.data,
        topics: log.topics,
      }) as unknown as { eventName: string; args: Record<string, unknown> };
      if (decoded.eventName !== 'Transfer') return;
      const args = decoded.args as unknown as { from: string; to: string; tokenId: bigint };
      // RevenueNFT.tokenIdOf(poolId) is a pure deterministic mapping (uint256(poolId)).
      const poolId = tokenIdToPoolId(args.tokenId);
      await this.market.applyRevenueNftTransfer(
        tx,
        ctx,
        { tokenId: args.tokenId, from: args.from.toLowerCase(), to: args.to.toLowerCase() },
        () => poolId,
      );
    } catch {
      // ignore
    }
  }

  private async applyRegistryLog(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    ctx: ProjectorContext,
    log: Log,
  ): Promise<void> {
    if (!log.topics[0]) return;
    try {
      const decoded = decodeEventLog({
        abi: PAYOUT_PLUGIN_REGISTRY_ABI,
        data: log.data,
        topics: log.topics,
      }) as unknown as { eventName: string; args: Record<string, unknown> };
      const args = decoded.args;
      switch (decoded.eventName) {
        case 'PluginRegistered': {
          const index = Number(args.index);
          await tx.pluginRegistryEntry.upsert({
            where: { chainId_index: { chainId: ctx.chainId, index } },
            create: {
              chainId: ctx.chainId,
              index,
              plugin: String(args.plugin).toLowerCase(),
              takeWad: wadToDecimal(BigInt((args.takeWad as bigint) ?? 0n)),
              gasLimit: Number(args.gasLimit ?? 0),
              codeHash: typeof args.codeHash === 'string' ? args.codeHash.toLowerCase() : '',
              role: Number(args.role ?? 0),
              registeredAtBlock: ctx.blockNumber,
              blockTime: ctx.blockTime,
            },
            update: {},
          });
          break;
        }
        case 'PluginSuspensionSet': {
          const index = Number(args.index);
          const suspended = Boolean(args.suspended);
          await tx.pluginRegistryEntry.updateMany({
            where: { chainId: ctx.chainId, index },
            data: { suspended },
          });
          break;
        }
        default:
          break;
      }
    } catch {
      // ignore
    }
  }

  private async applyControllerLog(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    ctx: ProjectorContext,
    log: Log,
  ): Promise<void> {
    if (!log.topics[0]) return;
    try {
      const decoded = decodeEventLog({
        abi: PROTOCOL_CONTROLLER_ABI,
        data: log.data,
        topics: log.topics,
      }) as unknown as { eventName: string; args: Record<string, unknown> };
      const args = decoded.args;
      switch (decoded.eventName) {
        case 'OperationScheduled': {
          const operationId = String(args.operationId).toLowerCase();
          await tx.governanceOperation.upsert({
            where: { chainId_operationId: { chainId: ctx.chainId, operationId } },
            create: {
              chainId: ctx.chainId,
              operationId,
              action: actionFromUint8(Number(args.action)),
              payload: {},
              status: 'SCHEDULED',
              readyAtBlock: null,
              readyAt: readyAtToDate(args.readyAt),
              blockTime: ctx.blockTime,
            },
            update: {
              status: 'SCHEDULED',
              readyAt: readyAtToDate(args.readyAt),
            },
          });
          break;
        }
        case 'OperationExecuted': {
          const operationId = String(args.operationId).toLowerCase();
          await tx.governanceOperation.updateMany({
            where: { chainId: ctx.chainId, operationId },
            data: { status: 'EXECUTED', executedAtBlock: ctx.blockNumber },
          });
          break;
        }
        case 'OperationCancelled': {
          const operationId = String(args.operationId).toLowerCase();
          await tx.governanceOperation.updateMany({
            where: { chainId: ctx.chainId, operationId },
            data: { status: 'CANCELLED', cancelledAtBlock: ctx.blockNumber },
          });
          break;
        }
        default:
          break;
      }
    } catch {
      // ignore
    }
  }

  /**
   * Boot backfill: read live protocol state once (template, economics, registry,
   * protocol recipient) and seed the projection tables that events alone cannot
   * reconstruct (they predate the indexer's start block).
   */
  private async bootBackfill(): Promise<void> {
    const chainId = this.config!.chainId;
    try {
      const [template, economics, entryCount] = await Promise.all([
        this.protocolReads.template(chainId),
        this.protocolReads.economicConfig(chainId),
        this.protocolReads.registryEntryCount(chainId),
      ]);
      void template;

      await this.prisma.economicConfigRecord.upsert({
        where: { chainId },
        create: {
          chainId,
          version: economics.version,
          harvestServiceFeeWad: wadToDecimal(economics.harvestServiceFeeWad),
          quoteCreatorShareWad: wadToDecimal(economics.quoteCreatorShareWad),
          tokenMilestoneFundShareWad: wadToDecimal(economics.tokenMilestoneFundShareWad),
          activatedAtBlock: 0n,
          blockTime: new Date(),
        },
        update: {
          version: economics.version,
          harvestServiceFeeWad: wadToDecimal(economics.harvestServiceFeeWad),
          quoteCreatorShareWad: wadToDecimal(economics.quoteCreatorShareWad),
          tokenMilestoneFundShareWad: wadToDecimal(economics.tokenMilestoneFundShareWad),
        },
      });

      for (let index = 0; index < entryCount; index += 1) {
        const entry = await this.protocolReads.registryEntry(chainId, index);
        await this.prisma.pluginRegistryEntry.upsert({
          where: { chainId_index: { chainId, index } },
          create: {
            chainId,
            index,
            plugin: entry.plugin.toLowerCase(),
            takeWad: wadToDecimal(entry.takeWad),
            gasLimit: entry.gasLimit,
            codeHash: entry.codeHash.toLowerCase(),
            role: entry.role,
            suspended: entry.suspended,
            registeredAtBlock: 0n,
            blockTime: new Date(),
          },
          update: {
            plugin: entry.plugin.toLowerCase(),
            takeWad: wadToDecimal(entry.takeWad),
            gasLimit: entry.gasLimit,
            codeHash: entry.codeHash.toLowerCase(),
            role: entry.role,
            suspended: entry.suspended,
          },
        });
      }
      this.logger.log(
        `boot backfill complete: economics v${economics.version}, ${entryCount} registry entries`,
      );
    } catch (error) {
      this.logger.warn(`boot backfill skipped: ${(error as Error).message}`);
    }
  }
}

function actionFromUint8(
  value: number,
):
  | 'SET_ECONOMIC_CONFIG'
  | 'SET_PROTOCOL_RECIPIENT'
  | 'REGISTER_PLUGIN'
  | 'SET_PLUGIN_SUSPENDED'
  | 'SET_GOVERNANCE_DELAY' {
  // ProtocolController.ACTION_* ordering: ECONOMIC_CONFIG, PROTOCOL_RECIPIENT,
  // REGISTER_PLUGIN, PLUGIN_SUSPENDED, GOVERNANCE_DELAY (values read live where
  // needed; the mapping is stable for the published contract).
  const actions = [
    'SET_ECONOMIC_CONFIG',
    'SET_PROTOCOL_RECIPIENT',
    'REGISTER_PLUGIN',
    'SET_PLUGIN_SUSPENDED',
    'SET_GOVERNANCE_DELAY',
  ] as const;
  return actions[value] ?? 'SET_ECONOMIC_CONFIG';
}

function readyAtToDate(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

function tokenIdToPoolId(tokenId: bigint): string | null {
  // RevenueNFT.tokenIdOf(poolId) = uint256(poolId): the bytes32 pool id zero-
  // extended to uint256. Inverse: hex-encode the uint256 to 32 bytes.
  const hex = tokenId.toString(16).padStart(64, '0');
  return `0x${hex}`;
}

function wadToDecimal(value: bigint): Prisma.Decimal {
  return new Prisma.Decimal(value.toString()).div(new Prisma.Decimal(10).pow(18));
}
