import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import 'reflect-metadata';

/**
 * Launch flow DTOs. The on-chain LaunchConfig fields use decimal strings for
 * 256-bit values per the API contract.
 */

export class TokenSocialsDto {
  @ApiPropertyOptional({ description: 'HTTPS website URL', example: 'https://example.com' })
  @IsOptional()
  @Matches(/^https:\/\/[^\s]+$/, { message: 'website must be an https URL' })
  website?: string;

  @ApiPropertyOptional({ description: 'HTTPS X/Twitter URL' })
  @IsOptional()
  @Matches(/^https:\/\/[^\s]+$/, { message: 'x must be an https URL' })
  x?: string;

  @ApiPropertyOptional({ description: 'HTTPS telegram URL' })
  @IsOptional()
  @Matches(/^https:\/\/[^\s]+$/, { message: 'telegram must be an https URL' })
  telegram?: string;

  @ApiPropertyOptional({ description: 'HTTPS discord URL' })
  @IsOptional()
  @Matches(/^https:\/\/[^\s]+$/, { message: 'discord must be an https URL' })
  discord?: string;
}

export class PrepareLaunchDto {
  @ApiProperty({ description: 'Declared creator; must equal the EIP-712 signer.', example: '0x…' })
  @Matches(/^0x[0-9a-fA-F]{40}$/, { message: 'creatorWalletAddress must be a hex address' })
  creatorWalletAddress!: string;

  @ApiProperty({ description: 'Token name', maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @Length(1, 80)
  name!: string;

  @ApiProperty({ description: 'Token symbol', example: 'SPWN', maxLength: 12 })
  @IsString()
  @Matches(/^[A-Z0-9]{1,12}$/, { message: 'symbol must be 1-12 uppercase alphanumeric characters' })
  symbol!: string;

  @ApiProperty({ description: 'Token description', maxLength: 8000 })
  @IsString()
  @IsNotEmpty()
  @Length(1, 8000)
  description!: string;

  @ApiProperty({ description: 'ipfs:// image URI (CIDv1)' })
  @Matches(/^ipfs:\/\/[a-zA-Z0-9]+/, { message: 'imageUri must be an ipfs:// URI' })
  @IsString()
  imageUri!: string;

  @ApiPropertyOptional({ type: TokenSocialsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TokenSocialsDto)
  socials?: TokenSocialsDto;

  @ApiProperty({ description: 'Total supply in token-wei; pinned by protocol to 1,000,000,000e18' })
  @IsString()
  @Matches(/^\d+$/, { message: 'totalSupply must be a non-negative decimal string' })
  totalSupply!: string;

  @ApiProperty({ description: 'Dev-buy share in WAD units (decimal string); hard cap 0.1e18' })
  @IsString()
  @Matches(/^\d+(\.\d+)?$/, { message: 'devBuyShareWad must be a decimal string' })
  devBuyShareWad!: string;

  @ApiProperty({
    description: 'Payout plan bitset (decimal string); bit i selects registry index i',
  })
  @IsString()
  @Matches(/^\d+$/, { message: 'payoutPlan must be a non-negative decimal string' })
  payoutPlan!: string;

  @ApiProperty({ description: 'Signature deadline (unix seconds)' })
  @IsInt()
  @Min(0)
  deadline!: number;
}

export class RelayLaunchDto {
  @ApiProperty({ description: 'UUID of the prepared launch record' })
  @IsString()
  @IsNotEmpty()
  launchId!: string;
}

export class LaunchStatusQueryDto {
  @ApiPropertyOptional({ description: 'Filter by creator wallet' })
  @IsOptional()
  @Matches(/^0x[0-9a-fA-F]{40}$/, { message: 'creator must be a hex address' })
  creator?: string;

  @ApiPropertyOptional({ description: 'Filter by state' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ description: 'Chain id', default: 8453 })
  @IsOptional()
  @IsInt()
  @Min(1)
  chainId?: number;

  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Page size', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(100)
  limit?: number;
}
