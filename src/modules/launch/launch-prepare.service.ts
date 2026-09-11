import { Injectable, Inject, Logger } from '@nestjs/common';
import { wadToDecimal } from '../../indexer/decimal-utils';
import { DomainException } from '../../common/http/domain.exception';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { BlockchainRegistryService } from '../../infrastructure/blockchain/blockchain-registry.service';
import { ProtocolReadService } from '../../infrastructure/blockchain/protocol-read.service';
import {
  TOKEN_METADATA_STORAGE,
  type TokenMetadata,
  type TokenMetadataStorage,
} from '../tokens/storage/token-metadata-storage';
import {
  launchConfigHash,
  launchDigest,
  launchTokenSalt,
  openingLevel,
  farLevel,
  devBuyQuote,
  type LaunchConfigInput,
} from '../../protocol/protocol-math';
import { MAX_DEV_BUY_SHARE_WAD } from '../../protocol/protocol-constants';
import { ChainClientFactory } from '../../infrastructure/blockchain/chain-client.factory';
import { LAUNCH_SUPPORT_ABI } from '../../infrastructure/blockchain/contract-abis';
import type { PrepareLaunchDto } from './dto/launch.dto';

/**
 * Launch preparation: validates a configuration against protocol bounds and the
 * live registry, uploads metadata, predicts the CREATE2 token address, computes the
 * EIP-712 digest, and quotes the optional dev buy. Returns everything the creator
 * needs to sign (and nothing they don't).
 */

@Injectable()
export class LaunchPrepareService {
  private readonly logger = new Logger(LaunchPrepareService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: BlockchainRegistryService,
    private readonly protocolReads: ProtocolReadService,
    private readonly clientFactory: ChainClientFactory,
    @Inject(TOKEN_METADATA_STORAGE) private readonly metadataStorage: TokenMetadataStorage,
  ) {}

  async prepare(input: PrepareLaunchDto): Promise<PrepareLaunchResponse> {
    const chainId = Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
    if (!this.registry.hasChain(chainId)) {
      throw new DomainException(
        503,
        'PROTOCOL_NOT_DEPLOYED',
        `No deployment manifest for chain ${chainId}`,
      );
    }
    const book = this.registry.book(chainId);

    const totalSupply = BigInt(input.totalSupply);
    const devBuyShareWad = parseWad(input.devBuyShareWad);
    const payoutPlan = BigInt(input.payoutPlan);
    const creator = input.creatorWalletAddress.toLowerCase();

    if (totalSupply <= 0n) {
      throw new DomainException(400, 'INVALID_TOTAL_SUPPLY', 'totalSupply must be positive');
    }
    if (devBuyShareWad > BigInt(MAX_DEV_BUY_SHARE_WAD)) {
      throw new DomainException(
        400,
        'DEV_BUY_ABOVE_CAP',
        'devBuyShareWad exceeds the 10% protocol cap',
      );
    }

    // Registry-aware plan validation (bit count, takes sum, selectable entries).
    await this.validatePayoutPlan(chainId, payoutPlan);

    // Opening/far geometry + dev-buy quote (pure math, exact).
    const template = await this.protocolReads.template(chainId);
    const opening = safeOpeningLevel(totalSupply, template.openingFdvWei);
    const far = safeFarLevel(opening, template.curveSpanLevels);
    const curveSupply = (totalSupply * template.curveSupplyShareWad) / 10n ** 18n;
    const devBuy =
      devBuyShareWad > 0n
        ? devBuyQuote({
            totalSupplyWei: totalSupply,
            devBuyShareWad,
            openingLevel: opening,
            farLevel: far,
            curvePositions: template.curvePositions,
            curveSupply,
            tradingFeeHundredthsBip: template.tradingFeeHundredthsBip,
          })
        : null;

    const config: LaunchConfigInput = {
      creator: creator as `0x${string}`,
      name: input.name,
      symbol: input.symbol,
      totalSupply,
      devBuyShareWad,
      payoutPlan,
      deadline: BigInt(input.deadline),
    };
    const configHash = launchConfigHash(config);
    const digest = launchDigest(config, book.hook as `0x${string}`, chainId);

    // Predict the token address on-chain (CREATE2 salt = keccak256(configHash, creator)).
    const predictedToken = await this.predictToken(chainId, book, config);

    // Upload metadata (best-effort name/symbol/description/image/socials bundle).
    let metadata: { ipfsUri: string; gatewayUrl: string } | null = null;
    try {
      const upload: TokenMetadata = {
        name: input.name,
        symbol: input.symbol,
        description: input.description,
        image: input.imageUri,
        socials: input.socials,
      };
      metadata = await this.metadataStorage.upload(upload);
    } catch (error) {
      this.logger.warn(`metadata upload failed for ${configHash}: ${(error as Error).message}`);
    }

    // Persist the launch record (idempotent per config: same config+creator = same row).
    const existing = await this.prisma.launchRecord.findUnique({
      where: { chainId_configHash_creatorWallet: { chainId, configHash, creatorWallet: creator } },
    });
    const record = existing
      ? await this.prisma.launchRecord.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            symbol: input.symbol,
            totalSupply: totalSupply.toString(),
            devBuyShareWad: wadToDecimal(devBuyShareWad),
            payoutPlan: payoutPlan.toString(),
            deadline: BigInt(input.deadline),
            digest,
            predictedToken,
            state: 'PENDING_SIGNATURE',
          },
        })
      : await this.prisma.launchRecord.create({
          data: {
            chainId,
            creatorWallet: creator,
            name: input.name,
            symbol: input.symbol,
            totalSupply: totalSupply.toString(),
            devBuyShareWad: wadToDecimal(devBuyShareWad),
            payoutPlan: payoutPlan.toString(),
            deadline: BigInt(input.deadline),
            configHash,
            predictedToken,
            signature: null,
            digest,
            mode: 'RELAYED',
            state: 'PENDING_SIGNATURE',
          },
        });

    // Link any offchain token row created earlier for this config (e.g. via a
    // pre-launch "reserve" flow) — none exists at prepare time in v1.

    return {
      launchId: record.id,
      chainId,
      config: {
        creator,
        name: input.name,
        symbol: input.symbol,
        totalSupply: input.totalSupply,
        devBuyShareWad: input.devBuyShareWad,
        payoutPlan: input.payoutPlan,
        deadline: input.deadline,
      },
      configHash,
      digest,
      domain: {
        name: 'SpawnLaunchpad',
        version: '1',
        chainId,
        verifyingContract: book.hook,
      },
      predictedToken,
      openingLevel: opening,
      farLevel: far,
      devBuyQuote: devBuy
        ? {
            tokensOut: devBuy.tokensOut.toString(),
            ethCost: devBuy.ethCost.toString(),
            suggestedMsgValueWithHeadroom: ((devBuy.ethCost * 105n) / 100n).toString(),
            endLevel: devBuy.endLevel,
          }
        : null,
      metadata,
      signaturePayload: {
        types: {
          LaunchConfig: [
            { name: 'creator', type: 'address' },
            { name: 'name', type: 'string' },
            { name: 'symbol', type: 'string' },
            { name: 'totalSupply', type: 'uint256' },
            { name: 'devBuyShareWad', type: 'uint64' },
            { name: 'payoutPlan', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'LaunchConfig',
        domain: {
          name: 'SpawnLaunchpad',
          version: '1',
          chainId,
          verifyingContract: book.hook,
        },
        message: {
          creator,
          name: input.name,
          symbol: input.symbol,
          totalSupply: input.totalSupply,
          devBuyShareWad: input.devBuyShareWad,
          payoutPlan: input.payoutPlan,
          deadline: input.deadline,
        },
      },
    };
  }

  private async validatePayoutPlan(chainId: number, payoutPlan: bigint): Promise<void> {
    if (payoutPlan === 0n) return; // empty plan is valid: creator is the remainder
    const bits: number[] = [];
    for (let i = 0; i < 256 && bits.length <= 8; i += 1) {
      if ((payoutPlan >> BigInt(i)) & 1n) bits.push(i);
    }
    if (bits.length > 8) {
      throw new DomainException(
        400,
        'PAYOUT_PLAN_TOO_MANY_PLUGINS',
        'a plan may select at most 8 payout plugins',
      );
    }
    let takesSum = 0n;
    for (const index of bits) {
      const entry = await this.protocolReads.registryEntry(chainId, index);
      if (entry.suspended) {
        throw new DomainException(
          400,
          'PAYOUT_PLAN_ENTRY_SUSPENDED',
          `registry entry ${index} is suspended`,
        );
      }
      if (entry.role !== 1) {
        // PluginRole.PAYOUT = 1 (INVALID=0, PAYOUT=1, CREATOR_SYSTEM=2, UTILITY=3)
        throw new DomainException(
          400,
          'PAYOUT_PLAN_ENTRY_NOT_SELECTABLE',
          `registry entry ${index} does not have the PAYOUT role`,
        );
      }
      takesSum += entry.takeWad;
    }
    if (takesSum > 10n ** 18n) {
      throw new DomainException(
        400,
        'PAYOUT_TAKES_ABOVE_WAD',
        'selected takes total more than one whole',
      );
    }
  }

  private async predictToken(
    chainId: number,
    book: ReturnType<BlockchainRegistryService['book']>,
    config: LaunchConfigInput,
  ): Promise<string> {
    const client = this.clientFactory.client(chainId);
    const salt = launchTokenSalt(launchConfigHash(config), config.creator);
    void salt;
    const address = await client.readContract({
      address: book.launchSupport as `0x${string}`,
      abi: LAUNCH_SUPPORT_ABI,
      functionName: 'predictToken',
      args: [
        {
          creator: config.creator,
          name: config.name,
          symbol: config.symbol,
          totalSupply: config.totalSupply,
          devBuyShareWad: config.devBuyShareWad,
          payoutPlan: config.payoutPlan,
          deadline: config.deadline,
        },
        book.hook,
      ] as never,
    });
    return String(address).toLowerCase();
  }
}

function parseWad(value: string): bigint {
  // devBuyShareWad arrives as a decimal string (possibly fractional); scale to wei.
  const [whole, fraction = ''] = value.split('.');
  const fractionPadded = (fraction + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole + fractionPadded);
}

function safeOpeningLevel(totalSupply: bigint, openingFdvWei: bigint): number {
  try {
    return openingLevel(totalSupply, openingFdvWei);
  } catch {
    throw new DomainException(
      400,
      'OPENING_LEVEL_OUT_OF_RANGE',
      'totalSupply places the opening level outside usable tick space',
    );
  }
}

function safeFarLevel(opening: number, spanLevels: number): number {
  try {
    return farLevel(opening, spanLevels);
  } catch {
    throw new DomainException(
      400,
      'FAR_LEVEL_OUT_OF_RANGE',
      'the far level for this supply exceeds usable tick space',
    );
  }
}

export type PrepareLaunchResponse = {
  launchId: string;
  chainId: number;
  config: {
    creator: string;
    name: string;
    symbol: string;
    totalSupply: string;
    devBuyShareWad: string;
    payoutPlan: string;
    deadline: number;
  };
  configHash: string;
  digest: string;
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  predictedToken: string;
  openingLevel: number;
  farLevel: number;
  devBuyQuote: {
    tokensOut: string;
    ethCost: string;
    suggestedMsgValueWithHeadroom: string;
    endLevel: number;
  } | null;
  metadata: { ipfsUri: string; gatewayUrl: string } | null;
  signaturePayload: Record<string, unknown>;
};
