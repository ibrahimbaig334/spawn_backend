import { IsIn, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../../common/pagination/pagination.dto';
import 'reflect-metadata';

export class TokenListQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Matches(/^0x[0-9a-f]{40}$/, { message: 'creator must be a lowercase hex address' })
  creator?: string;

  @IsOptional()
  @IsIn(['bonding', 'graduated'])
  phase?: 'bonding' | 'graduated';

  @IsOptional()
  @IsIn(['newest', 'oldest', 'market_cap', 'volume', 'graduated'])
  sort: 'newest' | 'oldest' | 'market_cap' | 'volume' | 'graduated' = 'newest';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId = Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
}

export class FeaturedTokensQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId = Number(process.env.DEFAULT_CHAIN_ID ?? 8453);
}
