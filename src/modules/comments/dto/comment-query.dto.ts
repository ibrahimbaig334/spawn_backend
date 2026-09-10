import { Transform } from 'class-transformer';
import { IsIn, IsString } from 'class-validator';
import { PaginationDto } from '../../../common/pagination/pagination.dto';
import { normalizeWallet } from './comment-mutation.dto';

export const COMMENT_SORTS = ['newest', 'oldest', 'top'] as const;

export class CommentsQueryDto extends PaginationDto {
  @IsIn(COMMENT_SORTS)
  sort: (typeof COMMENT_SORTS)[number] = 'newest';
}

export class CommentRepliesQueryDto extends PaginationDto {}

export class DeleteCommentQueryDto {
  @Transform(({ value }) => normalizeWallet(value))
  @IsString()
  walletAddress!: string;
}
