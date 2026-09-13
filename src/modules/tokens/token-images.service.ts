import { Injectable } from '@nestjs/common';
import { DomainException } from '../../common/http/domain.exception';
import { LOGO_CONTENT_TYPES } from './dto/upload-image.dto';
import { PinataService } from './storage/pinata-client';

export const LOGO_MAX_BYTES = 4.3 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function hasImageMagic(bytes: Buffer, contentType: string): boolean {
  if (bytes.length < 12) return false;
  switch (contentType) {
    case 'image/png':
      return (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif':
      return bytes.slice(0, 6).toString('ascii') === 'GIF87a' || bytes.slice(0, 6).toString('ascii') === 'GIF89a';
    case 'image/webp':
      return bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP';
    default:
      return false;
  }
}

export interface UploadedImage {
  ipfsUri: string;
  gatewayUrl: string;
  /** Browser-displayable URL (== gatewayUrl). */
  url: string;
}

/**
 * Logo intake: validates type/size/magic bytes, pins to Pinata, returns the
 * canonical `ipfs://` URI for API payloads plus a gateway URL for `<img>`.
 */
@Injectable()
export class TokenImagesService {
  constructor(private readonly pinata: PinataService) {}

  async uploadImage(
    filename: string,
    contentType: string,
    contentBase64: string,
  ): Promise<UploadedImage> {
    if (!(LOGO_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      throw new DomainException(400, 'UNSUPPORTED_IMAGE_TYPE', 'Logos must be PNG, JPEG, WEBP, or GIF.');
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(contentBase64, 'base64');
    } catch {
      throw new DomainException(400, 'INVALID_IMAGE_DATA', 'contentBase64 could not be decoded.');
    }
    if (bytes.length === 0) {
      throw new DomainException(400, 'INVALID_IMAGE_DATA', 'Image is empty.');
    }
    if (bytes.length > LOGO_MAX_BYTES) {
      throw new DomainException(400, 'IMAGE_TOO_LARGE', 'Logos must be under 4.3MB.');
    }
    if (!hasImageMagic(bytes, contentType)) {
      throw new DomainException(400, 'INVALID_IMAGE_DATA', 'File bytes do not match the declared image type.');
    }
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'logo';
    const name = `${Date.now()}-${safe}.${EXTENSIONS[contentType] ?? 'img'}`;
    try {
      const pinned = await this.pinata.pinFile(name, contentType, bytes);
      return { ipfsUri: pinned.ipfsUri, gatewayUrl: pinned.gatewayUrl, url: pinned.gatewayUrl };
    } catch (error) {
      throw new DomainException(503, 'IMAGE_UPLOAD_FAILED', (error as Error).message);
    }
  }
}
