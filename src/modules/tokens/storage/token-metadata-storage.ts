export const TOKEN_METADATA_STORAGE = Symbol('TOKEN_METADATA_STORAGE');

export interface TokenSocials {
  website?: string;
  x?: string;
  telegram?: string;
  discord?: string;
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  socials?: TokenSocials;
}

export interface MetadataUploadResult {
  ipfsUri: string;
  gatewayUrl: string;
}

export interface TokenMetadataStorage {
  upload(metadata: TokenMetadata): Promise<MetadataUploadResult>;
}
