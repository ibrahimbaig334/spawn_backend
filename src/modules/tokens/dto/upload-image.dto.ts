import { IsIn, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Logo upload payload. Images travel as base64 inside JSON so no multipart
 * parser is needed; the service pins the bytes to Pinata and returns an
 * `ipfs://` URI (matching the backend's ipfs-only image validation) plus a
 * gateway URL for browser display.
 */
export const LOGO_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export class UploadImageDto {
  @IsString()
  @MaxLength(128)
  filename!: string;

  @IsString()
  @IsIn([...LOGO_CONTENT_TYPES])
  contentType!: string;

  @IsString()
  @MaxLength(8_000_000)
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'contentBase64 must be base64' })
  contentBase64!: string;
}
