import { Injectable, Logger } from '@nestjs/common';
import { createWalletClient, http, type WalletClient, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { DomainException } from '../../common/http/domain.exception';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { BlockchainRegistryService } from '../../infrastructure/blockchain/blockchain-registry.service';
import { ChainClientFactory } from '../../infrastructure/blockchain/chain-client.factory';
import { MILESTONE_HOOK_ABI } from '../../infrastructure/blockchain/contract-abis';
import {
  launchDigest,
  launchConfigHash,
  type LaunchConfigInput,
} from '../../protocol/protocol-math';
import { decimalToBig } from '../../common/decimal-utils';
import { requestHash } from '../../common/crypto/request-hash';

/**
 * Relayed launch broadcast under the trusted-operator model.
 *
 * The protocol's on-chain `trustedOperator` is operated by this backend: the
 * operator key signs the complete EIP-712 LaunchConfig (creator never signs) and
 * the transaction is broadcast here. The record is then bound by the indexer when
 * the hook emits `Launched`.
 *
 * Production note (BACKEND_GUIDE §6.1): the operator key is the protocol's
 * highest-value secret after the admin multisig. Keep it in an HSM/Vault — this
 * implementation reads TRUSTED_OPERATOR_PRIVATE_KEY from the environment, which
 * is acceptable for staging; rotate through
 * `ProtocolController.scheduleTrustedOperator` on any suspicion of compromise.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

@Injectable()
export class LaunchRelayService {
  private readonly logger = new Logger(LaunchRelayService.name);
  private wallet?: WalletClient;
  private operatorAddress?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: BlockchainRegistryService,
    private readonly clientFactory: ChainClientFactory,
  ) {}

  private operatorConfigured(): boolean {
    return Boolean(process.env.TRUSTED_OPERATOR_PRIVATE_KEY);
  }

  async relay(
    launchId: string,
    idempotencyKey: string,
  ): Promise<{ response: RelayLaunchResponse; replayed: boolean }> {
    const record = await this.prisma.launchRecord.findUnique({ where: { id: launchId } });
    if (!record) {
      throw new DomainException(404, 'LAUNCH_RECORD_NOT_FOUND', `launch ${launchId} not found`);
    }
    if (record.state === 'SUBMITTED' || record.state === 'CONFIRMED') {
      return { response: present(record), replayed: true };
    }
    if (!this.operatorConfigured()) {
      throw new DomainException(
        503,
        'OPERATOR_NOT_CONFIGURED',
        'trusted operator key not configured; relay is unavailable',
      );
    }

    // Idempotency reservation keyed by the creator wallet.
    const scope = 'POST:/api/v1/launch/relay';
    const creator = record.creatorWallet.toLowerCase();
    const requestHashValue = requestHash(JSON.stringify({ launchId }));
    const existing = await this.prisma.idempotencyRequest.findUnique({
      where: { scope_walletAddress_key: { scope, walletAddress: creator, key: idempotencyKey } },
    });
    if (existing) {
      if (existing.state === 'COMPLETED' && existing.resourceId) {
        const completed = await this.prisma.launchRecord.findUnique({
          where: { id: existing.resourceId },
        });
        if (completed) return { response: present(completed), replayed: true };
      }
      if (existing.requestHash !== requestHashValue) {
        throw new DomainException(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'this idempotency key was used with a different body',
        );
      }
      throw new DomainException(
        409,
        'REQUEST_IN_PROGRESS',
        'a relay with this idempotency key is already in flight',
      );
    }
    await this.prisma.idempotencyRequest.create({
      data: {
        scope,
        walletAddress: creator,
        key: idempotencyKey,
        requestHash: requestHashValue,
        state: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });

    const chainId = record.chainId;
    if (!this.registry.hasChain(chainId)) {
      throw new DomainException(503, 'PROTOCOL_NOT_DEPLOYED', `no manifest for chain ${chainId}`);
    }
    const book = this.registry.book(chainId);

    const config: LaunchConfigInput = {
      creator: creator as Address,
      name: record.name,
      symbol: record.symbol,
      uri: record.uri,
      totalSupply: decimalToBig(record.totalSupply),
      devBuyShareWad: BigInt(record.devBuyShareWad.mul('1000000000000000000').toFixed()),
      payoutPlan: decimalToBig(record.payoutPlan),
      deadline: record.deadline,
    };
    void launchConfigHash(config); // sanity: binding identity must exist

    const wallet = this.ensureWallet();
    const publicClient = this.clientFactory.client(chainId);

    // Cross-check the on-chain trustedOperator before spending gas.
    const state = await this.prisma.protocolState.findUnique({ where: { chainId } });
    if (state?.trustedOperator === ZERO_ADDRESS) {
      throw new DomainException(
        503,
        'RELAY_DISABLED',
        'trustedOperator is zero on chain — relayed launches are disabled',
      );
    }
    if (
      this.operatorAddress &&
      state?.trustedOperator &&
      state.trustedOperator !== this.operatorAddress
    ) {
      this.logger.warn(
        `configured operator ${this.operatorAddress} != on-chain trustedOperator ${state.trustedOperator}; the launch will revert UnauthorizedLaunchSigner`,
      );
    }

    try {
      const digest = launchDigest(config, book.hook as Address, chainId);
      void digest;
      const signature = await wallet.signTypedData({
        domain: {
          name: 'SpawnLaunchpad',
          version: '1',
          chainId,
          verifyingContract: book.hook as Address,
        },
        types: {
          LaunchConfig: [
            { name: 'creator', type: 'address' },
            { name: 'name', type: 'string' },
            { name: 'symbol', type: 'string' },
            { name: 'uri', type: 'string' },
            { name: 'totalSupply', type: 'uint256' },
            { name: 'devBuyShareWad', type: 'uint64' },
            { name: 'payoutPlan', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'LaunchConfig',
        message: {
          creator: config.creator,
          name: config.name,
          symbol: config.symbol,
          uri: config.uri,
          totalSupply: config.totalSupply,
          devBuyShareWad: config.devBuyShareWad,
          payoutPlan: config.payoutPlan,
          deadline: config.deadline,
        },
      } as never);

      const hash = await wallet.writeContract({
        address: book.hook as Address,
        abi: MILESTONE_HOOK_ABI,
        functionName: 'launch',
        args: [config, signature] as never,
        chain: publicClient.chain ?? {
          id: chainId,
          name: `chain-${chainId}`,
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [] } },
        },
        account: wallet.account!,
        value: 0n, // relayed launches skip the dev buy; any attached value is refunded
      });

      const updated = await this.prisma.launchRecord.update({
        where: { id: record.id },
        data: { state: 'SUBMITTED', transactionHash: hash, submittedAt: new Date() },
      });
      await this.prisma.idempotencyRequest.update({
        where: { scope_walletAddress_key: { scope, walletAddress: creator, key: idempotencyKey } },
        data: { state: 'COMPLETED', responseStatus: 202, resourceId: record.id },
      });

      void this.watchReceipt(chainId, record.id, hash);
      return { response: present(updated), replayed: false };
    } catch (error) {
      await this.prisma.launchRecord.update({
        where: { id: record.id },
        data: { state: 'FAILED', failureReason: (error as Error).message.slice(0, 1000) },
      });
      throw new DomainException(502, 'LAUNCH_BROADCAST_FAILED', (error as Error).message);
    }
  }

  private async watchReceipt(
    chainId: number,
    launchId: string,
    hash: `0x${string}`,
  ): Promise<void> {
    try {
      const client = this.clientFactory.client(chainId);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status === 'success') {
        await this.prisma.launchRecord.update({
          where: { id: launchId },
          data: { blockNumber: receipt.blockNumber },
        });
      } else {
        await this.prisma.launchRecord.update({
          where: { id: launchId },
          data: { state: 'FAILED', failureReason: 'transaction reverted on chain' },
        });
      }
    } catch (error) {
      this.logger.warn(`watchReceipt failed for ${hash}: ${(error as Error).message}`);
    }
  }

  private ensureWallet(): WalletClient {
    if (!this.wallet) {
      const key = process.env.TRUSTED_OPERATOR_PRIVATE_KEY! as `0x${string}`;
      const account = privateKeyToAccount(key);
      this.operatorAddress = account.address.toLowerCase();
      const chainId = Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
      const chain =
        chainId === 8453 ? base : chainId === 84532 ? baseSepolia : { ...base, id: chainId };
      const rpcUrl = (process.env.CHAIN_RPC_URLS ?? '').split(',')[0]?.trim();
      const transport = rpcUrl ? http(rpcUrl) : http();
      this.wallet = createWalletClient({ chain, transport, account });
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
