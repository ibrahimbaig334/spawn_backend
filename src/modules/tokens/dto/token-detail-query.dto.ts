import { Transform, Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { TradeSide } from '@prisma/client';
import { PaginationDto } from '../../../common/pagination/pagination.dto';
import { API_TIMEFRAMES, type ApiTimeframe } from './query-values';

export const TRADE_SORTS = ['newest', 'oldest', 'amount'] as const;
export type TradeSort = (typeof TRADE_SORTS)[number];

export class TokenDetailQueryDto {
  @IsIn(API_TIMEFRAMES)
  timeframe: ApiTimeframe = '24h';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId = 8453;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  tradePage = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  tradeLimit = 20;
}

export class TokenTradesQueryDto extends PaginationDto {
  @IsOptional()
  @Transform(({ value }) => normalizeSide(value))
  @IsEnum(TradeSide)
  side?: TradeSide;

  @IsIn(TRADE_SORTS)
  sort: TradeSort = 'newest';

  @IsIn(API_TIMEFRAMES)
  timeframe: ApiTimeframe = '24h';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId = 8453;
}

function normalizeSide(value: unknown): unknown {
  return typeof value === 'string' ? value.toUpperCase() : value;
}
