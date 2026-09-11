import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { BlockchainRegistryService } from '../../infrastructure/blockchain/blockchain-registry.service';
import { ProtocolReadService } from '../../infrastructure/blockchain/protocol-read.service';import { PLUGIN_ROLES } from '../../protocol/protocol-constants';
import { pageMeta } from '../../common/pagination/page-result';
import { decimalToBig } from '../../indexer/decimal-utils';

/**
 * Protocol-wide reads: addresses from the deployment manifest, the versioned
 * economic tuple, the payout-plugin registry mirror, governance operations, global
 * protocol revenue accruals, and the indexer watermark.
 */

const ACTION_NAMES: Record<number, string> = {
  0: 'SET_ECONOMIC_CONFIG',
  1: 'SET_PROTOCOL_RECIPIENT',
  2: 'REGISTER_PLUGIN',
  3: 'SET_PLUGIN_SUSPENDED',
  4: 'SET_GOVERNANCE_DELAY',
};

@Injectable()
export class ProtocolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: BlockchainRegistryService,
    private readonly protocolReads: ProtocolReadService,
  ) {}

  private chainId(query: { chainId?: number }): number {
    return query.chainId ?? Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
  }

  addresses(query: { chainId?: number }) {
    const chainId = this.chainId(query);
    if (!this.registry.hasChain(chainId)) {
      throw new NotFoundException({
        code: 'MANIFEST_NOT_SYNCED',
        message: `no deployment manifest for chain ${chainId}`,
      });
    }
    const book = this.registry.book(chainId);
    return {
      chainId,
      hook: book.hook,
      launchSupport: book.launchSupport,
      revenueNft: book.revenueNft,
      payoutPluginRegistry: book.payoutPluginRegistry,
      protocolController: book.protocolController,
      buybackAndBurnPlugin: book.buybackAndBurnPlugin ?? null,
      poolManager: book.poolManager,
      stateView: book.stateView ?? null,
      v4Quoter: book.v4Quoter ?? null,
      multicall3: book.multicall3,
      canonicalPayoutPlan: book.canonicalPayoutPlan ?? null,
      hookSalt: book.hookSalt ?? null,
    };
  }

  async economics(query: { chainId?: number }) {
    const chainId = this.chainId(query);
    const row = await this.prisma.economicConfigRecord.findUnique({ where: { chainId } });
    if (row) {
      return {
        chainId,
        version: row.version.toString(),
        harvestServiceFeeWad: row.harvestServiceFeeWad.toFixed(),
        quoteCreatorShareWad: row.quoteCreatorShareWad.toFixed(),
        tokenMilestoneFundShareWad: row.tokenMilestoneFundShareWad.toFixed(),
        caps: {
          maxHarvestServiceFeeWad: '0.2',
          maxQuoteCreatorShareWad: '0.9',
          maxTokenMilestoneFundShareWad: '0.5',
        },
        activatedAtBlock: row.activatedAtBlock.toString(),
        blockTime: row.blockTime.toISOString(),
        source: 'indexer',
      };
    }
    // No indexer record yet: live read when a manifest exists.
    if (this.registry.hasChain(chainId)) {
      let live: Awaited<ReturnType<ProtocolReadService['economicConfig']>>;
      try {
        live = await this.protocolReads.economicConfig(chainId);
      } catch {
        throw new NotFoundException({
          code: 'ECONOMICS_NOT_AVAILABLE',
          message: 'the indexer has not committed an economic config and the live read failed (no RPC or protocol not deployed)',
        });
      }
      return {
        chainId,
        version: live.version.toString(),
        harvestServiceFeeWad: live.harvestServiceFeeWad.toString(),
        quoteCreatorShareWad: live.quoteCreatorShareWad.toString(),
        tokenMilestoneFundShareWad: live.tokenMilestoneFundShareWad.toString(),
        caps: {
          maxHarvestServiceFeeWad: '0.2',
          maxQuoteCreatorShareWad: '0.9',
          maxTokenMilestoneFundShareWad: '0.5',
        },
        activatedAtBlock: null,
        blockTime: null,
        source: 'live',
      };
    }
    throw new NotFoundException({
      code: 'ECONOMICS_NOT_AVAILABLE',
      message: 'no economic configuration recorded for this chain',
    });
  }

  async plugins(query: { chainId?: number }) {
    const chainId = this.chainId(query);
    const rows = await this.prisma.pluginRegistryEntry.findMany({
      where: { chainId },
      orderBy: { index: 'asc' },
    });
    return {
      data: rows.map((row) => ({
        index: row.index,
        plugin: row.plugin,
        takeWad: row.takeWad.toFixed(),
        gasLimit: row.gasLimit,
        codeHash: row.codeHash,
        role: PLUGIN_ROLES[row.role] ?? 'UNKNOWN',
        suspended: row.suspended,
        registeredAtBlock: row.registeredAtBlock.toString(),
      })),
      meta: pageMeta(1, 256, rows.length),
    };
  }

  async operations(query: { chainId?: number; status?: string }) {
    const chainId = this.chainId(query);
    const rows = await this.prisma.governanceOperation.findMany({
      where: {
        chainId,
        ...(query.status ? { status: query.status as never } : {}),
      },
      orderBy: { blockTime: 'desc' },
      take: 100,
    });
    return {
      data: rows.map((row) => ({
        operationId: row.operationId,
        action: row.action,
        status: row.status,
        readyAt: row.readyAt?.toISOString() ?? null,
        executedAtBlock: row.executedAtBlock !== null ? row.executedAtBlock.toString() : null,
        cancelledAtBlock: row.cancelledAtBlock !== null ? row.cancelledAtBlock.toString() : null,
        blockTime: row.blockTime.toISOString(),
      })),
      meta: pageMeta(1, 100, rows.length),
    };
  }

  async revenue(query: { chainId?: number }) {
    const chainId = this.chainId(query);
    const accruals = await this.prisma.revenueEvent.findMany({
      where: { chainId, kind: 'ProtocolAccrued' },
      orderBy: { blockNumber: 'desc' },
      take: 200,
    });
    const claims = await this.prisma.revenueEvent.findMany({
      where: { chainId, kind: 'ProtocolClaimed' },
      orderBy: { blockNumber: 'desc' },
      take: 50,
    });
    let totalAccrued = 0n;
    for (const row of accruals) totalAccrued += decimalToBig(row.amountRaw);
    let totalClaimed = 0n;
    for (const row of claims) totalClaimed += decimalToBig(row.amountRaw);

    return {
      chainId,
      totals: {
        accruedWei: totalAccrued.toString(),
        claimedWei: totalClaimed.toString(),
        unclaimedWei: (totalAccrued - totalClaimed).toString(),
      },
      accruals: accruals.map((row) => ({
        poolId: row.poolId,
        source: row.source,
        amountWei: row.amountRaw.toFixed(),
        economicVersion: row.economicVersion !== null ? row.economicVersion.toString() : null,
        transactionHash: row.transactionHash,
        blockNumber: row.blockNumber.toString(),
        blockTime: row.blockTime.toISOString(),
      })),
      claims: claims.map((row) => ({
        recipient: row.walletAddress,
        amountWei: row.amountRaw.toFixed(),
        transactionHash: row.transactionHash,
        blockNumber: row.blockNumber.toString(),
        blockTime: row.blockTime.toISOString(),
      })),
    };
  }

  async watermark(query: { chainId?: number }) {
    const chainId = this.chainId(query);
    const row = await this.prisma.chainWatermark.findUnique({ where: { chainId } });
    if (!row) {
      throw new NotFoundException({
        code: 'WATERMARK_NOT_FOUND',
        message: 'the indexer has not committed any block yet',
      });
    }
    return {
      chainId,
      committedVersion: row.committedVersion.toString(),
      blockNumber: row.blockNumber.toString(),
      blockHash: row.blockHash,
      blockTime: row.blockTime.toISOString(),
    };
  }
}

export { ACTION_NAMES };
