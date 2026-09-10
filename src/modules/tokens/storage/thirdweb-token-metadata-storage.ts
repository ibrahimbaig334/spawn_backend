import { Inject, Injectable } from '@nestjs/common';
import { createThirdwebClient } from 'thirdweb';
import { upload } from 'thirdweb/storage';
import { canonicalIpfsUri } from '../../../common/validation/ipfs-uri';
import { APP_ENVIRONMENT } from '../../../config/config.constants';
import type { Environment } from '../../../config/environment';
import type {
  MetadataUploadResult,
  TokenMetadata,
  TokenMetadataStorage,
} from './token-metadata-storage';

@Injectable()
export class ThirdwebTokenMetadataStorage implements TokenMetadataStorage {
  private readonly client;

  constructor(@Inject(APP_ENVIRONMENT) environment: Environment) {
    if (!environment.THIRDWEB_SECRET_KEY) {
      throw new Error('THIRDWEB_SECRET_KEY is required');
    }
    this.client = createThirdwebClient({ secretKey: environment.THIRDWEB_SECRET_KEY });
  }

  async upload(metadata: TokenMetadata): Promise<MetadataUploadResult> {
    const { socials, ...base } = metadata;
    const uploaded: unknown = await upload({
      client: this.client,
      files: [{ ...base, ...socials }],
    });
    const uri: unknown = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    if (typeof uri !== 'string' || !uri) {
      throw new Error('Thirdweb did not return an IPFS URI');
    }
    const ipfsUri = canonicalIpfsUri(uri);
    return {
      ipfsUri,
      gatewayUrl: ipfsUri.replace('ipfs://', 'https://ipfs.io/ipfs/'),
    };
  }
}
