import { Module } from '@nestjs/common';
import { CommentLikesController } from './comment-likes.controller';
import { CommentLikesService } from './comment-likes.service';
import { CommentRepliesController } from './comment-replies.controller';
import { CommentTokenResolver } from './comment-token-resolver';
import { CommentsController, TokenCommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  controllers: [
    TokenCommentsController,
    CommentsController,
    CommentRepliesController,
    CommentLikesController,
  ],
  providers: [CommentsService, CommentLikesService, CommentTokenResolver],
})
export class CommentsModule {}
