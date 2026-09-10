import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CommentsService } from './comments.service';
import { CommentRepliesQueryDto } from './dto/comment-query.dto';

@ApiTags('comments')
@Controller('comments/:id/replies')
export class CommentRepliesController {
  constructor(private readonly comments: CommentsService) {}

  @Get()
  @ApiOperation({ operationId: 'listCommentReplies' })
  replies(@Param('id') id: string, @Query() query: CommentRepliesQueryDto): Promise<unknown> {
    return this.comments.replies(id, query);
  }
}
