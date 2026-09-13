import { Injectable } from '@nestjs/common';
import type {
  MetadataUploadResult,
  TokenMetadata,
  TokenMetadataStorage,
} from './token-metadata-storage';
import { PinataService } from './pinata-client';

/**
 * Token metadata uploads via Pinata (server-side pinning).
 *
 * Drop-in replacement for ThirdwebTokenMetadataStorage: same
 * `{ ipfsUri, gatewayUrl }` shape, so launch/prepare and token creation
 * need no changes. Selected via METADATA_STORAGE_DRIVER=pinata.
 */
@Injectable()
export class PinataTokenMetadataStorage implements TokenMetadataStorage {
  constructor(private readonly pinata: PinataService) {}

  async upload(metadata: TokenMetadata): Promise<MetadataUploadResult> {
    const { socials, ...base } = metadata;
    const pinned = await this.pinata.pinJson(`token-metadata-${base.symbol}`, {
      ...base,
      ...socials,
    });
    return { ipfsUri: pinned.ipfsUri, gatewayUrl: pinned.gatewayUrl };
  }
}
