import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import 'reflect-metadata';

export class QuoteQueryDto {
  @ApiPropertyOptional({
    description: 'Direction: BUY (ETH in, token out) or SELL (token in, ETH out)',
    enum: ['BUY', 'SELL'],
  })
  @IsIn(['BUY', 'SELL'])
  side!: 'BUY' | 'SELL';

  @ApiPropertyOptional({
    description: 'Exact input amount (decimal string, token-wei for SELL, ETH-wei for BUY)',
  })
  @IsString()
  @Matches(/^\d+$/, { message: 'amount must be a decimal string' })
  @MinLength(1)
  amount!: string;

  @ApiPropertyOptional({ description: 'Chain id', default: 8453 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId?: number;
}

export class DepthQueryDto {
  @ApiPropertyOptional({
    description: 'Number of level buckets above spot (curve positions / band walls)',
    default: 8,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  buckets?: number;

  @ApiPropertyOptional({ description: 'Chain id', default: 8453 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId?: number;
}

export class PriceQueryDto {
  @ApiPropertyOptional({ description: 'Chain id', default: 8453 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId?: number;
}

export class WalletTradesQueryDto {
  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ description: 'Rows per page (max 100)', default: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Chain id', default: 8453 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId?: number;
}
