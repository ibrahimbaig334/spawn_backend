import { Injectable, Logger } from '@nestjs/common';
import { createWalletClient, http, type WalletClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { DomainException } from '../../common/http/domain.exception';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { BlockchainRegistryService } from '../../infrastructure/blockchain/blockchain-registry.service';
import { ChainClientFactory } from '../../infrastructure/blockchain/chain-client.factory';
import { MILESTONE_HOOK_ABI } from '../../infrastructure/blockchain/contract-abis';
import type { RelayLaunchDto } from './dto/launch.dto';

/**
 * Relayed launch broadcast. The backend submits the creator-signed configuration
 * through an optionally-configured relayer key and tracks submission state. The
 * relayer attaches no value (relayed launches skip the dev buy by protocol design)
 * and the relayer identity is never recorded as creator.
 */

@Injectable()
export class LaunchRelayService {
  private readonly logger = new Logger(LaunchRelayService.name);
  private wallet?: WalletClient;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: BlockchainRegistryService,
    private readonly clientFactory: ChainClientFactory,
  ) {}

  private relayerEnabled(): boolean {
    return process.env.RELAYER_ENABLED === 'true' && Boolean(process.env.RELAYER_PRIVATE_KEY);
  }

  async relay(
    input: RelayLaunchDto,
    idempotencyKey: string,
  ): Promise<{ response: RelayLaunchResponse; replayed: boolean }> {
    if (!this.relayerEnabled()) {
      throw new DomainException(503, 'RELAYER_DISABLED', 'The backend relayer is not enabled');
    }

    const record = await this.prisma.launchRecord.findUnique({ where: { id: input.launchId } });
    if (!record) {
      throw new DomainException(
        404,
        'LAUNCH_RECORD_NOT_FOUND',
        `launch ${input.launchId} not found`,
      );
    }
    if (record.state === 'SUBMITTED' || record.state === 'CONFIRMED') {
      return { response: present(record), replayed: true };
    }

    // Idempotency reservation.
    const chainId = record.chainId;
    const scope = 'POST:/api/v1/launch/relay';
    const creator = record.creatorWallet.toLowerCase();
    const requestHash =
      '0x' + Buffer.from(JSON.stringify({ launchId: input.launchId })).toString('hex');
    const existingIdem = await this.prisma.idempotencyRequest.findUnique({
      where: { scope_walletAddress_key: { scope, walletAddress: creator, key: idempotencyKey } },
    });
    if (existingIdem) {
      if (existingIdem.state === 'COMPLETED' && existingIdem.resourceId) {
        const completed = await this.prisma.launchRecord.findUnique({
          where: { id: existingIdem.resourceId },
        });
        if (completed) return { response: present(completed), replayed: true };
      }
      if (existingIdem.requestHash !== requestHash) {
        throw new DomainException(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'this idempotency key was used with a different body',
        );
      }
      throw new DomainException(
        409,
        'REQUEST_IN_PROGRESS',
        'a launch with this idempotency key is already in flight',
      );
    }
    await this.prisma.idempotencyRequest.create({
      data: {
        scope,
        walletAddress: creator,
        key: idempotencyKey,
        requestHash,
        state: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    });

    if (!this.registry.hasChain(chainId)) {
      throw new DomainException(503, 'PROTOCOL_NOT_DEPLOYED', `no manifest for chain ${chainId}`);
    }
    const book = this.registry.book(chainId);

    const config = {
      creator,
      name: record.name,
      symbol: record.symbol,
      totalSupply: record.totalSupply,
      devBuyShareWad: record.devBuyShareWad,
      payoutPlan: record.payoutPlan,
      deadline: record.deadline,
    };

    const wallet = this.ensureWallet();
    const publicClient = this.clientFactory.client(chainId);

    try {
      const hash = await wallet.writeContract({
        address: book.hook as `0x${string}`,
        abi: MILESTONE_HOOK_ABI,
        functionName: 'launch',
        args: [config, input.signature as `0x${string}`] as never,
        chain: publicClient.chain,
        account: wallet.account!,
      });

      const updated = await this.prisma.launchRecord.update({
        where: { id: record.id },
        data: {
          signature: input.signature,
          state: 'SUBMITTED',
          transactionHash: hash,
          submittedAt: new Date(),
        },
      });

      await this.prisma.idempotencyRequest.update({
        where: { scope_walletAddress_key: { scope, walletAddress: creator, key: idempotencyKey } },
        data: { state: 'COMPLETED', responseStatus: 202, resourceId: record.id },
      });

      // Confirmation is asynchronous: the indexer observes Launched and links the
      // onchain state via configHash; this watcher marks the receipt outcome.
      void this.watchConfirmation(chainId, record.id, hash);

      return { response: present(updated), replayed: false };
    } catch (error) {
      await this.prisma.launchRecord.update({
        where: { id: record.id },
        data: {
          state: 'FAILED',
          failureReason: (error as Error).message.slice(0, 1000),
        },
      });
      throw new DomainException(502, 'LAUNCH_BROADCAST_FAILED', (error as Error).message);
    }
  }

  private async watchConfirmation(
    chainId: number,
    launchId: string,
    hash: `0x${string}`,
  ): Promise<void> {
    try {
      const client = this.clientFactory.client(chainId);
      const receipt = await client.waitForTransactionReceipt({ hash });
      const success = receipt.status === 'success';
      await this.prisma.launchRecord.update({
        where: { id: launchId },
        data: success
          ? { state: 'SUBMITTED', transactionHash: hash, blockNumber: receipt.blockNumber }
          : { state: 'FAILED', failureReason: 'transaction reverted on chain' },
      });
    } catch (error) {
      this.logger.warn(`watchConfirmation failed for ${hash}: ${(error as Error).message}`);
    }
  }

  private ensureWallet(): WalletClient {
    if (!this.wallet) {
      const key = process.env.RELAYER_PRIVATE_KEY!;
      const chainId = Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
      const chain =
        chainId === 8453 ? base : chainId === 84532 ? baseSepolia : { ...base, id: chainId };
      const rpcUrl = (process.env.CHAIN_RPC_URLS ?? '').split(',')[0]?.trim();
      const transport = rpcUrl ? http(rpcUrl) : http();
      this.wallet = createWalletClient({ chain, transport, account: key as `0x${string}` });
    }
    return this.wallet;
  }
}

export type RelayLaunchResponse = {
  launchId: string;
  state: string;
  transactionHash: string | null;
  predictedToken: string;
  configHash: string;
};

function present(record: {
  id: string;
  state: string;
  transactionHash: string | null;
  predictedToken: string;
  configHash: string;
}): RelayLaunchResponse {
  return {
    launchId: record.id,
    state: record.state,
    transactionHash: record.transactionHash,
    predictedToken: record.predictedToken,
    configHash: record.configHash,
  };
}
