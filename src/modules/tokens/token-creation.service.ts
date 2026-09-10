import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { canonicalize } from 'json-canonicalize';
import { Prisma } from '@prisma/client';
import { DeploymentSignerCustody } from '../../common/crypto/deployment-signer-custody';
import { DomainException } from '../../common/http/domain.exception';
import { APP_ENVIRONMENT } from '../../config/config.constants';
import type { Environment } from '../../config/environment';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { CreateTokenDto } from './dto/create-token.dto';
import {
  TOKEN_METADATA_STORAGE,
  type MetadataUploadResult,
  type TokenMetadataStorage,
} from './storage/token-metadata-storage';

export interface CreatedToken {
  tokenId: string;
  name: string;
  symbol: string;
  description: string;
  claimedCreatorWallet: string;
  imageUri: string;
  socials: unknown;
  ipfsUri: string;
  gatewayUrl: string;
  deploymentSignerAddress: string;
  contractAddress: null;
  createdAt: Date;
}

@Injectable()
export class TokenCreationService {
  private readonly custody: DeploymentSignerCustody;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TOKEN_METADATA_STORAGE) private readonly storage: TokenMetadataStorage,
    @Inject(APP_ENVIRONMENT) environment: Environment,
  ) {
    if (!environment.encryptionKey || !environment.PRIVATE_KEY_ENCRYPTION_KEY_ID) {
      throw new Error('Token creation requires deployment signer encryption configuration');
    }
    this.custody = new DeploymentSignerCustody(
      environment.encryptionKey,
      environment.PRIVATE_KEY_ENCRYPTION_KEY_ID,
    );
  }

  async create(
    input: CreateTokenDto,
    idempotencyKey: string,
  ): Promise<{ value: CreatedToken; replayed: boolean }> {
    const requestHash = this.hash(input);
    const reservation = await this.reserve(input, idempotencyKey, requestHash);
    if (reservation) return reservation;

    let uploaded: MetadataUploadResult;
    try {
      uploaded = await this.storage.upload({
        name: input.name,
        symbol: input.symbol,
        description: input.description,
        image: input.imageUri,
        ...(input.socials ? { socials: input.socials } : {}),
      });
    } catch {
      await this.releaseReservation(input, idempotencyKey, requestHash);
      throw new DomainException(
        503,
        'METADATA_UPLOAD_FAILED',
        'Token metadata could not be uploaded',
      );
    }

    const tokenId = randomUUID();
    const signer = this.custody.generate(tokenId);
    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.profile.upsert({
            where: { walletAddress: input.creatorWalletAddress },
            create: { walletAddress: input.creatorWalletAddress },
            update: {},
          });
          await tx.token.create({
            data: {
              id: tokenId,
              claimedCreatorWallet: input.creatorWalletAddress,
              name: input.name,
              symbol: input.symbol,
              description: input.description,
              imageUri: input.imageUri,
              ipfsUri: uploaded.ipfsUri,
              gatewayUrl: uploaded.gatewayUrl,
              socials: input.socials ? { ...input.socials } : Prisma.JsonNull,
            },
          });
          await tx.tokenDeploymentSigner.create({
            data: { tokenId, signerAddress: signer.signerAddress },
          });
          await tx.$executeRaw`
            SELECT insert_token_deployment_secret(
              ${tokenId}::uuid,
              ${signer.version},
              ${signer.algorithm}::varchar,
              ${signer.keyId}::varchar,
              ${signer.iv},
              ${signer.ciphertext},
              ${signer.authTag}
            )
          `;
          const completed = await tx.idempotencyRequest.updateMany({
            where: {
              scope: 'POST:/api/v1/tokens',
              walletAddress: input.creatorWalletAddress,
              key: idempotencyKey,
              requestHash,
              state: 'IN_PROGRESS',
            },
            data: { state: 'COMPLETED', resourceId: tokenId, responseStatus: 201 },
          });
          if (completed.count !== 1) throw new Error('Token creation reservation was lost');
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      await this.releaseReservation(input, idempotencyKey, requestHash);
      throw error;
    } finally {
      signer.iv.fill(0);
      signer.ciphertext.fill(0);
      signer.authTag.fill(0);
    }

    return { value: await this.findCreated(tokenId), replayed: false };
  }

  private async reserve(
    input: CreateTokenDto,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<{ value: CreatedToken; replayed: true } | null> {
    const where = {
      scope_walletAddress_key: {
        scope: 'POST:/api/v1/tokens',
        walletAddress: input.creatorWalletAddress,
        key: idempotencyKey,
      },
    } as const;
    const existing = await this.prisma.idempotencyRequest.findUnique({ where });
    if (existing) return this.replay(existing, requestHash);

    try {
      await this.prisma.idempotencyRequest.create({
        data: {
          scope: 'POST:/api/v1/tokens',
          walletAddress: input.creatorWalletAddress,
          key: idempotencyKey,
          requestHash,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
        },
      });
      return null;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await this.prisma.idempotencyRequest.findUniqueOrThrow({ where });
      return this.replay(raced, requestHash);
    }
  }

  private async releaseReservation(
    input: CreateTokenDto,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<void> {
    await this.prisma.idempotencyRequest.deleteMany({
      where: {
        scope: 'POST:/api/v1/tokens',
        walletAddress: input.creatorWalletAddress,
        key: idempotencyKey,
        requestHash,
        state: 'IN_PROGRESS',
      },
    });
  }

  private async replay(
    existing: { requestHash: string; resourceId: string | null },
    requestHash: string,
  ): Promise<{ value: CreatedToken; replayed: true }> {
    if (existing.requestHash !== requestHash) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency-Key was already used with a different request',
      });
    }
    if (!existing.resourceId) {
      throw new ConflictException({
        code: 'REQUEST_IN_PROGRESS',
        message: 'Token creation is in progress',
      });
    }
    return { value: await this.findCreated(existing.resourceId), replayed: true };
  }

  private hash(input: CreateTokenDto): string {
    return `0x${createHash('sha256').update(canonicalize(input)).digest('hex')}`;
  }

  private async findCreated(tokenId: string): Promise<CreatedToken> {
    const token = await this.prisma.token.findUniqueOrThrow({
      where: { id: tokenId },
      include: { deploymentSigner: true },
    });
    if (!token.deploymentSigner) throw new Error('Incomplete token record');
    return {
      tokenId: token.id,
      name: token.name,
      symbol: token.symbol,
      description: token.description,
      claimedCreatorWallet: token.claimedCreatorWallet,
      imageUri: token.imageUri,
      socials: token.socials,
      ipfsUri: token.ipfsUri,
      gatewayUrl: token.gatewayUrl,
      deploymentSignerAddress: token.deploymentSigner.signerAddress,
      contractAddress: null,
      createdAt: token.createdAt,
    };
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
