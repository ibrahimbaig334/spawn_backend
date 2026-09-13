import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import 'reflect-metadata';

export const API_CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type ApiCandleInterval = (typeof API_CANDLE_INTERVALS)[number];

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
  chainId = Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
}

export class TokenMilestonesQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId = Number(process.env.DEFAULT_CHAIN_ID ?? 8453);

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}

export const REVENUE_EVENT_KINDS = [
  'creatorAccruals',
  'protocolAccruals',
  'creatorPathAccruals',
  'claims',
  'payoutTips',
  'pluginPayouts',
  'potFundings',
  'potRedemptions',
  'feeCollections',
  'feeRoutings',
  'tokenBurns',
  'graduates',
] as const;

export class TokenRevenueQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @IsOptional()
  @IsIn(REVENUE_EVENT_KINDS)
  kind?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId = Number(process.env.DEFAULT_CHAIN_ID ?? 8453);

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}
