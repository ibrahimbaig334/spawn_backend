import { Type } from 'class-transformer';
import { IsIn, IsInt, Min } from 'class-validator';
import { PaginationDto } from '../../../common/pagination/pagination.dto';

export const CREATOR_TOKEN_SORTS = ['newest', 'oldest'] as const;

export class ProfileTokensQueryDto extends PaginationDto {
  @IsIn(CREATOR_TOKEN_SORTS)
  sort: (typeof CREATOR_TOKEN_SORTS)[number] = 'newest';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId = 8453;
}
