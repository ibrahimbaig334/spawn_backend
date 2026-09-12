import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { decodeEventLog, erc20Abi } from 'viem';
import type { Log } from 'viem';
import { Prisma, type PrismaService } from '../infrastructure/database/prisma.service';
import { ChainClientFactory } from '../infrastructure/blockchain/chain-client.factory';
import { BlockchainRegistryService } from '../infrastructure/blockchain/blockchain-registry.service';
import { ProtocolReadService } from '../infrastructure/blockchain/protocol-read.service';
import {
  PAYOUT_PLUGIN_REGISTRY_ABI,
  PROTOCOL_CONTROLLER_ABI,
  REVENUE_NFT_ABI,
} from '../infrastructure/blockchain/contract-abis';
import { BlockIngesterService, type IndexerConfig } from './block-ingester.service';
import { ProjectionApplier, type ProjectorContext } from './projection-applier';
import { MarketProjector } from './market-projector';
import { decodeHookEvent, decodePoolManagerEvent, type DecodedHookEvent } from './event-decoder';
import { rebuildAggregates } from './aggregate-rebuild';
import { pluginRoleFromUint8, accrualSourceFromUint8 } from '../protocol/protocol-constants';

/**
 * The indexer orchestrator: polls confirmed blocks, fetches filtered logs,
 * decodes, and applies projections atomically per block. Reorgs roll back via
 * the ingester's receipt ledger.
 */

@Injectable()
export class IndexerService implements OnModuleDestroy {
  private readonly logger = new Logger(IndexerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopping = false;
  private config?: IndexerConfig;
  private actionsByValue: Record<number, string> = {};

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
        this.logger.warn(`rolled back ${rolledBack} blocks after reorg; rebuilding aggregates`);
        await this.prisma.$transaction(async (tx) => {
          await rebuildAggregates(tx, this.config!.chainId);
        });
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

    const logs = await client.getLogs({ fromBlock: block.number, toBlock: block.number });

    await this.prisma.$transaction(
      async (tx) => {
        const version = await this.ingester.nextVersion(tx);
        const base: ProjectorContext = {
          chainId,
          blockNumber: block.number,
          blockHash: block.hash,
          blockTime: block.timestamp,
          version,
          txHash: '',
          logIndex: 0,
          transactionIndex: 0,
          hookAddress: book.hook,
          poolManagerAddress: book.poolManager,
        };

        // Pass 1: raw ledger + hook events, in log order.
        for (const log of logs) {
          const ctx = {
            ...base,
            txHash: log.transactionHash ?? '',
            logIndex: log.logIndex,
            transactionIndex: log.transactionIndex ?? 0,
          };
          await tx.rawChainEvent
            .create({
              data: {
                chainId,
                blockNumber: block.number,
                logIndex: log.logIndex,
                transactionIndex: ctx.transactionIndex,
                transactionHash: ctx.txHash,
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
              this.logger.warn(`rawChainEvent insert skipped: ${(error as Error).message}`);
            });

          if (log.address.toLowerCase() !== book.hook.toLowerCase()) continue;
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

        // Pass 2: PoolManager swaps (facts + candles + aggregates).
        for (const log of logs) {
          if (log.address.toLowerCase() !== book.poolManager.toLowerCase()) continue;
          const ctx = {
            ...base,
            txHash: log.transactionHash ?? '',
            logIndex: log.logIndex,
            transactionIndex: log.transactionIndex ?? 0,
          };
          const decoded = decodePoolManagerEvent(log);
          if (decoded?.name === 'Swap') {
            await this.market.applySwap(tx, ctx, decoded);
          }
        }

        // Pass 3: launch-token burns (ERC-20 Transfer to zero) + RevenueNFT transfers.
        for (const log of logs) {
          const address = log.address.toLowerCase();
          const ctx = {
            ...base,
            txHash: log.transactionHash ?? '',
            logIndex: log.logIndex,
            transactionIndex: log.transactionIndex ?? 0,
          };
          if (address === book.revenueNft.toLowerCase()) {
            await this.applyRevenueNftLog(tx, ctx, log);
          } else {
            await this.applyTokenTransferLog(tx, ctx, address, log);
          }
        }

        // Pass 4: registry + controller.
        for (const log of logs) {
          const address = log.address.toLowerCase();
          const ctx = {
            ...base,
            txHash: log.transactionHash ?? '',
            logIndex: log.logIndex,
            transactionIndex: log.transactionIndex ?? 0,
          };
          if (address === book.payoutPluginRegistry.toLowerCase()) {
            await this.applyRegistryLog(tx, ctx, log);
          } else if (address === book.protocolController.toLowerCase()) {
            await this.applyControllerLog(tx, ctx, log);
          }
        }

        await tx.protocolState.upsert({
          where: { chainId },
          create: { chainId, lastIndexedBlock: block.number },
          update: { lastIndexedBlock: block.number },
        });

        await this.ingester.commitBlock(tx, block, version);
      },
      { timeout: 120_000, isolationLevel: 'Serializable' },
    );

    this.logger.debug(`ingested block ${block.number} (${logs.length} logs)`);
  }

  private tryDecodeHookEvent(log: Log): DecodedHookEvent | null {
    try {
      return decodeHookEvent(log);
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
      const decoded = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics,
      }) as unknown as {
        eventName: string;
        args: Record<string, unknown>;
      };
      if (decoded.eventName !== 'Transfer') return;
      const args = decoded.args as unknown as { from: string; to: string; value: bigint };
      await this.market.applyTokenTransfer(tx, ctx, {
        token,
        from: args.from.toLowerCase(),
        to: args.to.toLowerCase(),
        value: args.value,
      });
    } catch {
      // not a tracked token / not a Transfer; ignore
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
      }) as unknown as {
        eventName: string;
        args: Record<string, unknown>;
      };
      if (decoded.eventName !== 'Transfer') return;
      const args = decoded.args as unknown as { from: string; to: string; tokenId: bigint };
      await this.market.applyRevenueNftTransfer(tx, ctx, {
        tokenId: args.tokenId,
        from: args.from.toLowerCase(),
        to: args.to.toLowerCase(),
      });
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
      }) as unknown as {
        eventName: string;
        args: Record<string, unknown>;
      };
      const args = decoded.args;
      switch (decoded.eventName) {
        case 'PluginRegistered': {
          const index = Number(args.index);
          const role = pluginRoleFromUint8(Number(args.role)) ?? 'INVALID';
          await tx.pluginRegistryEntry.upsert({
            where: { chainId_registryIndex: { chainId: ctx.chainId, registryIndex: index } },
            create: {
              chainId: ctx.chainId,
              registryIndex: index,
              plugin: String(args.plugin).toLowerCase(),
              takeWad: wadDecimal(BigInt((args.takeWad as bigint) ?? 0n)),
              gasLimit: Number(args.gasLimit ?? 0),
              codeHash: typeof args.codeHash === 'string' ? args.codeHash.toLowerCase() : '',
              role,
              registeredBlock: ctx.blockNumber,
            },
            update: {
              plugin: String(args.plugin).toLowerCase(),
              takeWad: wadDecimal(BigInt((args.takeWad as bigint) ?? 0n)),
              gasLimit: Number(args.gasLimit ?? 0),
              codeHash: typeof args.codeHash === 'string' ? args.codeHash.toLowerCase() : '',
              role,
              registeredBlock: ctx.blockNumber,
            },
          });
          break;
        }
        case 'PluginSuspensionSet': {
          await tx.pluginRegistryEntry.updateMany({
            where: { chainId: ctx.chainId, registryIndex: Number(args.index) },
            data: { suspended: Boolean(args.suspended) },
          });
          break;
        }
        case 'AdministratorProposed': {
          await tx.protocolState.upsert({
            where: { chainId: ctx.chainId },
            create: {
              chainId: ctx.chainId,
              pendingAdministrator: String(args.pendingAdministrator).toLowerCase(),
              lastIndexedBlock: ctx.blockNumber,
            },
            update: {
              pendingAdministrator: String(args.pendingAdministrator).toLowerCase(),
              lastIndexedBlock: ctx.blockNumber,
            },
          });
          break;
        }
        case 'AdministratorAccepted': {
          await tx.protocolState.upsert({
            where: { chainId: ctx.chainId },
            create: {
              chainId: ctx.chainId,
              administrator: String(args.administrator).toLowerCase(),
              lastIndexedBlock: ctx.blockNumber,
            },
            update: {
              administrator: String(args.administrator).toLowerCase(),
              pendingAdministrator: null,
              lastIndexedBlock: ctx.blockNumber,
            },
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
      }) as unknown as {
        eventName: string;
        args: Record<string, unknown>;
      };
      const args = decoded.args;
      switch (decoded.eventName) {
        case 'OperationScheduled': {
          const operationId = String(args.operationId).toLowerCase();
          const action = this.actionName(Number(args.action));
          await tx.governanceOperation.upsert({
            where: { chainId_operationId: { chainId: ctx.chainId, operationId } },
            create: {
              chainId: ctx.chainId,
              operationId,
              action,
              payload: {},
              status: 'SCHEDULED',
              readyAt: readyAtToDate(args.readyAt),
              blockTime: ctx.blockTime,
            },
            update: {
              status: 'SCHEDULED',
              action,
              readyAt: readyAtToDate(args.readyAt),
              blockTime: ctx.blockTime,
            },
          });
          break;
        }
        case 'OperationExecuted': {
          await tx.governanceOperation.updateMany({
            where: { chainId: ctx.chainId, operationId: String(args.operationId).toLowerCase() },
            data: { status: 'EXECUTED', executedAtBlock: ctx.blockNumber },
          });
          break;
        }
        case 'OperationCancelled': {
          await tx.governanceOperation.updateMany({
            where: { chainId: ctx.chainId, operationId: String(args.operationId).toLowerCase() },
            data: { status: 'CANCELLED', cancelledAtBlock: ctx.blockNumber },
          });
          break;
        }
        case 'EconomicConfigUpdated': {
          await tx.protocolState.upsert({
            where: { chainId: ctx.chainId },
            create: {
              chainId: ctx.chainId,
              economicVersion: BigInt((args.version as bigint) ?? 1n),
              lastIndexedBlock: ctx.blockNumber,
            },
            update: {
              economicVersion: BigInt((args.version as bigint) ?? 1n),
              lastIndexedBlock: ctx.blockNumber,
            },
          });
          break;
        }
        case 'ProtocolRecipientUpdated': {
          await tx.protocolState.upsert({
            where: { chainId: ctx.chainId },
            create: {
              chainId: ctx.chainId,
              protocolRecipient: String(args.recipient).toLowerCase(),
              lastIndexedBlock: ctx.blockNumber,
            },
            update: {
              protocolRecipient: String(args.recipient).toLowerCase(),
              lastIndexedBlock: ctx.blockNumber,
            },
          });
          break;
        }
        case 'TrustedOperatorUpdated': {
          const operator = String(args.operator).toLowerCase();
          await tx.protocolState.upsert({
            where: { chainId: ctx.chainId },
            create: {
              chainId: ctx.chainId,
              trustedOperator: operator,
              trustedOperatorBlock: ctx.blockNumber,
              lastIndexedBlock: ctx.blockNumber,
            },
            update: {
              trustedOperator: operator,
              trustedOperatorBlock: ctx.blockNumber,
              lastIndexedBlock: ctx.blockNumber,
            },
          });
          break;
        }
        case 'GovernanceDelayUpdated': {
          await tx.protocolState.upsert({
            where: { chainId: ctx.chainId },
            create: {
              chainId: ctx.chainId,
              governanceDelaySeconds: BigInt((args.newDelay as bigint) ?? 0n),
              lastIndexedBlock: ctx.blockNumber,
            },
            update: {
              governanceDelaySeconds: BigInt((args.newDelay as bigint) ?? 0n),
              lastIndexedBlock: ctx.blockNumber,
            },
          });
          break;
        }
        case 'AdministratorProposed': {
          await tx.protocolState.upsert({
            where: { chainId: ctx.chainId },
            create: {
              chainId: ctx.chainId,
              pendingAdministrator: String(args.pendingAdministrator).toLowerCase(),
              lastIndexedBlock: ctx.blockNumber,
            },
            update: {
              pendingAdministrator: String(args.pendingAdministrator).toLowerCase(),
              lastIndexedBlock: ctx.blockNumber,
            },
          });
          break;
        }
        case 'AdministratorAccepted': {
          await tx.protocolState.upsert({
            where: { chainId: ctx.chainId },
            create: {
              chainId: ctx.chainId,
              administrator: String(args.administrator).toLowerCase(),
              lastIndexedBlock: ctx.blockNumber,
            },
            update: {
              administrator: String(args.administrator).toLowerCase(),
              pendingAdministrator: null,
              lastIndexedBlock: ctx.blockNumber,
            },
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

  private actionName(
    value: number,
  ):
    | 'SET_ECONOMIC_CONFIG'
    | 'SET_PROTOCOL_RECIPIENT'
    | 'REGISTER_PLUGIN'
    | 'SET_PLUGIN_SUSPENDED'
    | 'SET_GOVERNANCE_DELAY'
    | 'SET_TRUSTED_OPERATOR' {
    return (this.actionsByValue[value] ?? 'SET_ECONOMIC_CONFIG') as never;
  }

  /**
   * Boot backfill: live protocol state the event stream can't reconstruct from a
   * mid-chain start point (economics, registry, governance, trusted operator).
   */
  private async bootBackfill(): Promise<void> {
    const chainId = this.config!.chainId;
    try {
      const [template, economics, entryCount, controller] = await Promise.all([
        this.protocolReads.template(chainId),
        this.protocolReads.economicConfig(chainId),
        this.protocolReads.registryEntryCount(chainId),
        this.protocolReads.controllerState(chainId),
      ]);

      // Discover the ACTION_* constants so OperationScheduled action bytes decode
      // to names for the published contract (no guessing).
      this.actionsByValue = controller.actions;

      await this.prisma.economicConfig.upsert({
        where: { chainId_version: { chainId, version: economics.version } },
        create: {
          chainId,
          version: economics.version,
          harvestServiceFeeWad: wadDecimal(economics.harvestServiceFeeWad),
          quoteCreatorShareWad: wadDecimal(economics.quoteCreatorShareWad),
          tokenMilestoneFundShareWad: wadDecimal(economics.tokenMilestoneFundShareWad),
          effectiveBlock: 0n,
          effectiveAt: new Date(),
        },
        update: {
          harvestServiceFeeWad: wadDecimal(economics.harvestServiceFeeWad),
          quoteCreatorShareWad: wadDecimal(economics.quoteCreatorShareWad),
          tokenMilestoneFundShareWad: wadDecimal(economics.tokenMilestoneFundShareWad),
        },
      });

      await this.prisma.protocolState.upsert({
        where: { chainId },
        create: {
          chainId,
          economicVersion: economics.version,
          protocolRecipient: controller.protocolRecipient ?? null,
          trustedOperator: controller.trustedOperator ?? null,
          administrator: controller.administrator ?? null,
          pendingAdministrator: controller.pendingAdministrator ?? null,
          governanceDelaySeconds: controller.governanceDelay ?? null,
          lastIndexedBlock: 0n,
        },
        update: {
          economicVersion: economics.version,
          protocolRecipient: controller.protocolRecipient ?? null,
          trustedOperator: controller.trustedOperator ?? null,
          administrator: controller.administrator ?? null,
          pendingAdministrator: controller.pendingAdministrator ?? null,
          governanceDelaySeconds: controller.governanceDelay ?? null,
        },
      });

      for (let index = 0; index < entryCount; index += 1) {
        const entry = await this.protocolReads.registryEntry(chainId, index);
        await this.prisma.pluginRegistryEntry.upsert({
          where: { chainId_registryIndex: { chainId, registryIndex: index } },
          create: {
            chainId,
            registryIndex: index,
            plugin: entry.plugin.toLowerCase(),
            takeWad: wadDecimal(entry.takeWad),
            gasLimit: entry.gasLimit,
            codeHash: entry.codeHash.toLowerCase(),
            role: pluginRoleFromUint8(entry.role) ?? 'INVALID',
            suspended: entry.suspended,
            registeredBlock: 0n,
          },
          update: {
            plugin: entry.plugin.toLowerCase(),
            takeWad: wadDecimal(entry.takeWad),
            gasLimit: entry.gasLimit,
            codeHash: entry.codeHash.toLowerCase(),
            role: pluginRoleFromUint8(entry.role) ?? 'INVALID',
            suspended: entry.suspended,
          },
        });
      }

      this.assertTemplate(template);
      this.logger.log(
        `boot backfill complete: economics v${economics.version}, ${entryCount} registry entries, trustedOperator=${controller.trustedOperator ?? 'unset'}`,
      );
    } catch (error) {
      this.logger.warn(`boot backfill skipped: ${(error as Error).message}`);
    }
  }

  private assertTemplate(template: Awaited<ReturnType<ProtocolReadService['template']>>): void {
    // The data-layer views assume the canonical template (pinned supply, 13862-level
    // curve, 22-band decaying ladder). A deployment-generation change must be an
    // explicit decision, not a silent drift.
    const expected: Record<string, number | bigint> = {
      curvePositions: 32,
      curveSpanLevels: 13862,
      bandLevelSpacing: 2235,
      bandFirstStepLevels: 6932,
      bandStepDecayLevels: 391,
      bandWidthLevels: 447,
      coreBandCount: 22,
      maxFeeFundedBands: 30,
      openingFdvWei: 2000000000000000000n,
    };
    for (const [key, value] of Object.entries(expected)) {
      const actual = (template as unknown as Record<string, number | bigint>)[key];
      if (actual !== undefined && BigInt(actual) !== BigInt(value)) {
        throw new Error(
          `template.${key} = ${actual} does not match the canonical deployment (${value}); update protocol constants and data layer together`,
        );
      }
    }
    void accrualSourceFromUint8;
  }
}

function readyAtToDate(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

function wadDecimal(value: bigint): Prisma.Decimal {
  return new Prisma.Decimal(value.toString()).div(new Prisma.Decimal(10).pow(18));
}
