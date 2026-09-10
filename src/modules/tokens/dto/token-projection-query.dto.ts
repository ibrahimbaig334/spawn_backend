import { Transform, Type } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CandleInterval, MilestoneKind, MilestoneState } from '@prisma/client';
import { PaginationDto } from '../../../common/pagination/pagination.dto';

export const API_CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type ApiCandleInterval = (typeof API_CANDLE_INTERVALS)[number];

export const PRISMA_CANDLE_INTERVALS: Record<ApiCandleInterval, CandleInterval> = {
  '1m': CandleInterval.M1,
  '5m': CandleInterval.M5,
  '15m': CandleInterval.M15,
  '1h': CandleInterval.H1,
  '4h': CandleInterval.H4,
  '1d': CandleInterval.D1,
};

export class TokenCandlesQueryDto {
  @IsIn(API_CANDLE_INTERVALS)
  interval: ApiCandleInterval = '1h';

  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit = 500;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId = 8453;
}

export class TokenMilestonesQueryDto extends PaginationDto {
  @IsOptional()
  @Transform(({ value }) => normalizeEnum(value))
  @IsEnum(MilestoneKind)
  kind?: MilestoneKind;

  @IsOptional()
  @Transform(({ value }) => normalizeEnum(value))
  @IsEnum(MilestoneState)
  state?: MilestoneState;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId = 8453;
}

function normalizeEnum(value: unknown): unknown {
  return typeof value === 'string' ? value.toUpperCase() : value;
}
