import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { Type } from 'class-transformer';
import 'reflect-metadata';

export class LaunchRecordQueryDto {
  @ApiPropertyOptional({ description: 'Chain id', default: 8453 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId?: number;
}

export const LAUNCH_RECORD_STATES = [
  'PENDING_SIGNATURE',
  'SUBMITTED',
  'CONFIRMED',
  'REORGED',
  'FAILED',
] as const;

export class LaunchRecordsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by creator wallet' })
  @IsOptional()
  @Matches(/^0x[0-9a-fA-F]{40}$/, { message: 'creator must be a hex address' })
  creator?: string;

  @ApiPropertyOptional({ enum: LAUNCH_RECORD_STATES })
  @IsOptional()
  @IsIn(LAUNCH_RECORD_STATES)
  state?: string;

  @ApiPropertyOptional({ description: 'Chain id', default: 8453 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId?: number;

  @ApiPropertyOptional({ description: 'Page', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Limit', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsString()
  sort?: string;
}

export { LaunchStatusQueryDto } from './launch.dto';
