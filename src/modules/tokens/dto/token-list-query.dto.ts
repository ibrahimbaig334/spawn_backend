import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { OnchainPhase } from '@prisma/client';
import { PaginationDto } from '../../../common/pagination/pagination.dto';
import {
  API_TIMEFRAMES,
  type ApiTimeframe,
  normalizeOptionalLowercase,
  parseOptionalBoolean,
} from './query-values';

export const TOKEN_LIST_SORTS = [
  'newest',
  'oldest',
  'market_cap',
  'volume',
  'graduated',
  'relevance',
] as const;
export type TokenListSort = (typeof TOKEN_LIST_SORTS)[number];

export class TokenListQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Transform(({ value }) => normalizeOptionalLowercase(value))
  @Matches(/^0x[0-9a-f]{40}$/)
  creator?: string;

  @IsOptional()
  @IsEnum(OnchainPhase)
  phase?: OnchainPhase;

  @IsOptional()
  @Transform(({ value }) => parseOptionalBoolean(value))
  @IsBoolean()
  hasOnchainProjection?: boolean;

  @IsIn(TOKEN_LIST_SORTS)
  sort: TokenListSort = 'newest';

  @IsIn(API_TIMEFRAMES)
  timeframe: ApiTimeframe = '24h';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId = 8453;
}

export class FeaturedTokensQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId = 8453;
}
