import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { canonicalize } from 'json-canonicalize';
import { DomainException } from '../../common/http/domain.exception';
import { requestHash } from '../../common/crypto/request-hash';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  TOKEN_METADATA_STORAGE,
  type TokenMetadataStorage,
} from './storage/token-metadata-storage';

/**
 * Offchain token registration: metadata upload + a tokens row keyed by creator.
 *
 * The on-chain launch is a separate, signed flow (see the launch module): the
 * creator signs the EIP-712 LaunchConfig and either self-sends or relays through
 * this backend. The indexer links the launched pool to an offchain row via the
 * configHash — when a launch flows through `launch/prepare`, the prepared row is
 * reused; a purely onchain launch gets a bare row created by the indexer.
 *
 * This endpoint exists so a token page, comments, and profiles can exist before
 * (and independently of) the onchain launch.
 */

const SCOPE = 'POST:/api/v1/tokens';
const IDEMPOTENCY_RETENTION_DAYS = 30;

export interface CreateTokenInput {
  creatorWalletAddress: string;
  name: string;
  symbol: string;
  description: string;
  imageUri: string;
  socials?: { website?: string; x?: string; telegram?: string; discord?: string };
}

export interface CreatedToken {
  tokenId: string;
  chainId: number;
  name: string;
  symbol: string;
  description: string;
  claimedCreatorWallet: string;
  imageUri: string;
  socials: CreateTokenInput['socials'] | Prisma.JsonValue | null;
  ipfsUri: string;
  gatewayUrl: string;
  contractAddress: null;
  createdAt: Date;
}

@Injectable()
export class TokenCreationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TOKEN_METADATA_STORAGE) private readonly metadataStorage: TokenMetadataStorage,
  ) {}

  async create(
    input: CreateTokenInput,
    idempotencyKey: string,
  ): Promise<{ value: CreatedToken; replayed: boolean }> {
    const creator = input.creatorWalletAddress.toLowerCase();
    const requestHashValue = requestHash(canonicalize(input));

    const replay = await this.replay(creator, idempotencyKey, requestHashValue);
    if (replay) return replay;

    await this.reserve(creator, idempotencyKey, requestHashValue);

    let metadata;
    try {
      metadata = await this.metadataStorage.upload({
        name: input.name,
        symbol: input.symbol,
        description: input.description,
        image: input.imageUri,
        socials: input.socials,
      });
    } catch (error) {
      await this.releaseReservation(creator, idempotencyKey, requestHashValue);
      throw new DomainException(503, 'METADATA_UPLOAD_FAILED', (error as Error).message);
    }

    const chainId = Number(process.env.DEFAULT_CHAIN_ID ?? 8453);

    try {
      const tokenId = await this.prisma.$transaction(
        async (tx) => {
          await tx.profile.upsert({
            where: { walletAddress: creator },
            create: { walletAddress: creator },
            update: {},
          });
          const token = await tx.token.create({
            data: {
              chainId,
              claimedCreatorWallet: creator,
              name: input.name,
              symbol: input.symbol,
              description: input.description,
              imageUri: input.imageUri,
              ipfsUri: metadata.ipfsUri,
              gatewayUrl: metadata.gatewayUrl,
              socials: (input.socials ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            },
          });
          await tx.idempotencyRequest.update({
            where: {
              scope_walletAddress_key: {
                scope: SCOPE,
                walletAddress: creator,
                key: idempotencyKey,
              },
            },
            data: { state: 'COMPLETED', responseStatus: 201, resourceId: token.id },
          });
          return token.id;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

      return { value: await this.findCreated(tokenId), replayed: false };
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const replayed = await this.replay(creator, idempotencyKey, requestHashValue);
        if (replayed) return replayed;
      }
      throw error;
    }
  }

  private async findCreated(tokenId: string): Promise<CreatedToken> {
    const token = await this.prisma.token.findUnique({ where: { id: tokenId } });
    if (!token) throw new DomainException(500, 'INTERNAL_ERROR', 'token disappeared after create');
    return {
      tokenId: token.id,
      chainId: token.chainId,
      name: token.name,
      symbol: token.symbol,
      description: token.description,
      claimedCreatorWallet: token.claimedCreatorWallet,
      imageUri: token.imageUri,
      socials: token.socials,
      ipfsUri: token.ipfsUri,
      gatewayUrl: token.gatewayUrl,
      contractAddress: null,
      createdAt: token.createdAt,
    };
  }

  private async reserve(
    creator: string,
    idempotencyKey: string,
    requestHashValue: string,
  ): Promise<void> {
    await this.prisma.idempotencyRequest.create({
      data: {
        scope: SCOPE,
        walletAddress: creator,
        key: idempotencyKey,
        requestHash: requestHashValue,
        state: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + IDEMPOTENCY_RETENTION_DAYS * 24 * 3600 * 1000),
      },
    });
  }

  private async releaseReservation(
    creator: string,
    idempotencyKey: string,
    requestHashValue: string,
  ): Promise<void> {
    await this.prisma.idempotencyRequest.deleteMany({
      where: {
        scope: SCOPE,
        walletAddress: creator,
        key: idempotencyKey,
        requestHash: requestHashValue,
        state: 'IN_PROGRESS',
      },
    });
  }

  private async replay(
    creator: string,
    idempotencyKey: string,
    requestHashValue: string,
  ): Promise<{ value: CreatedToken; replayed: boolean } | null> {
    const existing = await this.prisma.idempotencyRequest.findUnique({
      where: {
        scope_walletAddress_key: { scope: SCOPE, walletAddress: creator, key: idempotencyKey },
      },
    });
    if (!existing) return null;
    if (existing.requestHash !== requestHashValue) {
      throw new DomainException(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'this idempotency key was used with a different body',
      );
    }
    if (existing.state !== 'COMPLETED' || !existing.resourceId) {
      throw new DomainException(
        409,
        'REQUEST_IN_PROGRESS',
        'a request with this idempotency key is already in flight',
      );
    }
    return { value: await this.findCreated(existing.resourceId), replayed: true };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
