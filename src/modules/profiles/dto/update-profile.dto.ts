import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { isAddress } from 'viem';
import { DomainException } from '../../../common/http/domain.exception';
import { canonicalIpfsUri } from '../../../common/validation/ipfs-uri';
import { countCodePoints } from '../../../common/validation/text';

export class UpdateProfileDto {
  @IsOptional()
  @Transform(({ value }) => normalizeUsername(value))
  @IsString()
  @Matches(/^[A-Za-z0-9_]{3,32}$/)
  username?: string | null;

  @IsOptional()
  @Transform(({ value }) => normalizeBio(value))
  @IsString()
  @MaxLength(1200)
  bio?: string | null;

  @IsOptional()
  @Transform(({ value }) => normalizeImageUri(value))
  @IsString()
  imageUri?: string | null;
}

export function normalizeWalletAddress(value: string): string {
  const normalized = value.toLowerCase();
  if (!isAddress(normalized, { strict: true }) || /^0x0{40}$/u.test(normalized)) {
    throw new DomainException(
      400,
      'INVALID_WALLET_ADDRESS',
      'walletAddress must be a nonzero EVM address',
    );
  }
  return normalized;
}

function normalizeUsername(value: unknown): unknown {
  if (value === null || typeof value !== 'string') return value;
  return value.normalize('NFC');
}

function normalizeBio(value: unknown): unknown {
  if (value === null || typeof value !== 'string') return value;
  const normalized = value.normalize('NFC');
  if (countCodePoints(normalized) > 300)
    throw new Error('bio must contain at most 300 code points');
  return normalized;
}

function normalizeImageUri(value: unknown): unknown {
  if (value === null || typeof value !== 'string') return value;
  return canonicalIpfsUri(value);
}
