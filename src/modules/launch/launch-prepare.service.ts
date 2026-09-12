import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ChainClientFactory } from '../../infrastructure/blockchain/chain-client.factory';
import { BlockchainRegistryService } from '../../infrastructure/blockchain/blockchain-registry.service';
import { ProtocolReadService } from '../../infrastructure/blockchain/protocol-read.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  TOKEN_METADATA_STORAGE,
  type TokenMetadata,
  type TokenMetadataStorage,
} from '../tokens/storage/token-metadata-storage';
import { DomainException } from '../../common/http/domain.exception';
import {
  devBuyQuote,
  farLevel,
  launchConfigHash,
  launchDigest,
  launchTokenSalt,
  openingLevel,
  type LaunchConfigInput,
} from '../../protocol/protocol-math';
import {
  FIXED_TOTAL_SUPPLY,
  MAX_DEV_BUY_SHARE_WAD,
  PROTOCOL_TEMPLATE_DEFAULT,
} from '../../protocol/protocol-constants';
import { LAUNCH_SUPPORT_ABI } from '../../infrastructure/blockchain/contract-abis';
import type { Address } from 'viem';
import type { PrepareLaunchDto } from './dto/launch.dto';

/**
 * Launch preparation: validates the configuration against protocol bounds and the
 * live registry, uploads metadata (whose gateway URL becomes the on-chain token
 * `uri`), predicts the CREATE2 token address, computes the EIP-712 digest, and
 * quotes the optional dev buy.
 *
 * Under the trusted-operator model the creator never signs: the backend operator
 * key signs the config at relay time (see launch-relay.service).
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

    const creator = input.creatorWalletAddress.toLowerCase() as Address;
    const totalSupply = BigInt(input.totalSupply);
    const devBuyShareWad = parseWad(input.devBuyShareWad);
    const payoutPlan = BigInt(input.payoutPlan);
    const fixedSupply = BigInt(FIXED_TOTAL_SUPPLY);

    if (totalSupply !== fixedSupply) {
      throw new DomainException(
        400,
        'SUPPLY_NOT_FIXED',
        `totalSupply is pinned by the protocol to ${fixedSupply.toString()} (1,000,000,000 tokens); any other value reverts`,
      );
    }
    if (devBuyShareWad > BigInt(MAX_DEV_BUY_SHARE_WAD)) {
      throw new DomainException(
        400,
        'DEV_BUY_ABOVE_CAP',
        'devBuyShareWad exceeds the 10% protocol cap',
      );
    }

    await this.validatePayoutPlan(chainId, payoutPlan);

    // Metadata upload first: the resulting gateway URL is the on-chain token uri.
    let metadata: { ipfsUri: string; gatewayUrl: string };
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
      throw new DomainException(503, 'METADATA_UPLOAD_FAILED', (error as Error).message);
    }
    const uri = metadata.gatewayUrl;

    const template = await this.protocolReads.template(chainId);
    const opening = safeOpeningLevel(totalSupply, template.openingFdvWei);
    const far = safeFarLevel(opening, template.curveSpanLevels);
    const curveSupply = mulDivWad(totalSupply, template.curveSupplyShareWad);
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
      creator,
      name: input.name,
      symbol: input.symbol,
      uri,
      totalSupply,
      devBuyShareWad,
      payoutPlan,
      deadline: BigInt(input.deadline),
    };
    const configHash = launchConfigHash(config);
    const digest = launchDigest(config, book.hook as Address, chainId);
    const predictedToken = await this.predictToken(chainId, book, config);
    void launchTokenSalt; // salt = keccak(configHash, creator); used by predictToken views

    const existing = await this.prisma.launchRecord.findUnique({
      where: {
        chainId_configHash_creatorWallet: { chainId, configHash, creatorWallet: creator },
      },
    });
    const record = existing
      ? await this.prisma.launchRecord.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            symbol: input.symbol,
            uri,
            description: input.description,
            imageUri: input.imageUri,
            ipfsUri: metadata.ipfsUri,
            gatewayUrl: metadata.gatewayUrl,
            socials: (input.socials ?? Prisma.JsonNull) as never,
            deadline: BigInt(input.deadline),
            digest,
            predictedToken,
            state: existing.state === 'PENDING_RELAY' ? 'PENDING_RELAY' : existing.state,
          },
        })
      : await this.prisma.launchRecord.create({
          data: {
            chainId,
            creatorWallet: creator,
            name: input.name,
            symbol: input.symbol,
            uri,
            description: input.description,
            imageUri: input.imageUri,
            ipfsUri: metadata.ipfsUri,
            gatewayUrl: metadata.gatewayUrl,
            socials: (input.socials ?? undefined) as never,
            totalSupply: totalSupply.toString(),
            devBuyShareWad: wadDecimal(devBuyShareWad),
            payoutPlan: payoutPlan.toString(),
            deadline: BigInt(input.deadline),
            configHash,
            predictedToken,
            digest,
            state: 'PENDING_RELAY',
          },
        });

    return {
      launchId: record.id,
      chainId,
      config: {
        creator,
        name: input.name,
        symbol: input.symbol,
        uri,
        totalSupply: totalSupply.toString(),
        devBuyShareWad: input.devBuyShareWad,
        payoutPlan: input.payoutPlan,
        deadline: input.deadline,
      },
      configHash,
      digest,
      domain: { name: 'SpawnLaunchpad', version: '1', chainId, verifyingContract: book.hook },
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
      signatureNote:
        'The backend trusted operator signs this configuration at relay time; the creator never signs. Direct creator launches (with dev buy) can be sent by the creator wallet calling launch(config, "0x") with value attached.',
      signaturePayload: {
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
        domain: { name: 'SpawnLaunchpad', version: '1', chainId, verifyingContract: book.hook },
        message: {
          creator,
          name: input.name,
          symbol: input.symbol,
          uri,
          totalSupply: totalSupply.toString(),
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
        // PluginRole.PAYOUT = 1
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
    const address = await client.readContract({
      address: book.launchSupport as Address,
      abi: LAUNCH_SUPPORT_ABI,
      functionName: 'predictToken',
      args: [
        {
          creator: config.creator,
          name: config.name,
          symbol: config.symbol,
          uri: config.uri,
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
  const [whole, fraction = ''] = value.split('.');
  const fractionPadded = (fraction + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole + fractionPadded);
}

function mulDivWad(a: bigint, wad: bigint): bigint {
  return (a * wad) / 10n ** 18n;
}

function wadDecimal(value: bigint): Prisma.Decimal {
  return new Prisma.Decimal(value.toString()).div(new Prisma.Decimal(10).pow(18));
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

void PROTOCOL_TEMPLATE_DEFAULT;

export type PrepareLaunchResponse = {
  launchId: string;
  chainId: number;
  config: {
    creator: string;
    name: string;
    symbol: string;
    uri: string;
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
  signatureNote: string;
  signaturePayload: Record<string, unknown>;
};
