import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import 'reflect-metadata';

export class TokenDetailQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  tradePage = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  tradeLimit = 20;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId = 8453;
}

export class TokenTradesQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsIn(['BUY', 'SELL'])
  side?: 'BUY' | 'SELL';

  @IsOptional()
  @IsIn(['newest', 'oldest', 'amount'])
  sort: 'newest' | 'oldest' | 'amount' = 'newest';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId = 8453;

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}
