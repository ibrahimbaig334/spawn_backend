import { Transform, Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { isAddress } from 'viem';
import { canonicalIpfsUri } from '../../../common/validation/ipfs-uri';
import { collapseWhitespace, countCodePoints, countWords } from '../../../common/validation/text';

export class TokenSocialsDto {
  @IsOptional()
  @Transform(({ value }) => normalizeSocialUrl(value))
  @IsUrl({ protocols: ['https'], require_protocol: true, require_valid_protocol: true })
  @MaxLength(512)
  website?: string;

  @IsOptional()
  @Transform(({ value }) => normalizeSocialUrl(value))
  @IsUrl({ protocols: ['https'], require_protocol: true, require_valid_protocol: true })
  @MaxLength(512)
  x?: string;

  @IsOptional()
  @Transform(({ value }) => normalizeSocialUrl(value))
  @IsUrl({ protocols: ['https'], require_protocol: true, require_valid_protocol: true })
  @MaxLength(512)
  telegram?: string;

  @IsOptional()
  @Transform(({ value }) => normalizeSocialUrl(value))
  @IsUrl({ protocols: ['https'], require_protocol: true, require_valid_protocol: true })
  @MaxLength(512)
  discord?: string;
}

export class CreateTokenDto {
  @Transform(({ value }) => normalizeWallet(value))
  @IsString()
  creatorWalletAddress!: string;

  @Transform(({ value }) => normalizeName(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  name!: string;

  @Transform(({ value }) => normalizeSymbol(value))
  @IsString()
  @Matches(/^[A-Z0-9]{1,12}$/)
  symbol!: string;

  @Transform(({ value }) => normalizeDescription(value))
  @IsString()
  @MaxLength(8000)
  description!: string;

  @Transform(({ value }) => normalizeImageUri(value))
  @IsString()
  imageUri!: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => TokenSocialsDto)
  socials?: TokenSocialsDto;
}

function normalizeWallet(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.toLowerCase();
  if (!isAddress(normalized, { strict: true }) || /^0x0{40}$/.test(normalized)) {
    throw new Error('creatorWalletAddress must be a nonzero EVM address');
  }
  return normalized;
}

function normalizeName(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = collapseWhitespace(value.normalize('NFC'));
  const length = countCodePoints(normalized);
  if (length < 1 || length > 80) throw new Error('name must contain 1 to 80 code points');
  return normalized;
}

function normalizeSymbol(value: unknown): unknown {
  return typeof value === 'string' ? value.normalize('NFC') : value;
}

function normalizeDescription(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = collapseWhitespace(value.normalize('NFC'));
  const words = countWords(normalized);
  if (words < 5 || words > 100) throw new Error('description must contain 5 to 100 words');
  return normalized;
}

function normalizeImageUri(value: unknown): unknown {
  return typeof value === 'string' ? canonicalIpfsUri(value) : value;
}

function normalizeSocialUrl(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  if (!normalized) return undefined;
  const url = new URL(normalized);
  if (url.protocol !== 'https:') throw new Error('Social URLs must use HTTPS');
  url.hash = '';
  return url.toString();
}
