import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { isAddress } from 'viem';
import { DomainException } from '../../../common/http/domain.exception';
import { countCodePoints } from '../../../common/validation/text';

export class CreateCommentDto {
  @Transform(({ value }) => normalizeWallet(value))
  @IsString()
  walletAddress!: string;

  @Transform(({ value }) => normalizeText(value))
  @IsString()
  @MaxLength(8000)
  text!: string;

  @IsOptional()
  @IsUUID()
  parentCommentId?: string;
}

export class CommentWalletDto {
  @Transform(({ value }) => normalizeWallet(value))
  @IsString()
  walletAddress!: string;
}

export function normalizeWallet(value: unknown): unknown {
  if (typeof value !== 'string') return value;
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

function normalizeText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.normalize('NFC');
  const length = countCodePoints(normalized);
  if (length < 1 || length > 2_000) {
    throw new Error('text must contain 1 to 2000 code points');
  }
  return normalized;
}
