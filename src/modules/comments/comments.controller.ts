import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { validateIdempotencyKey } from '../../common/http/idempotency-key';
import { RateLimit } from '../../infrastructure/rate-limit/rate-limit.decorator';
import { RATE_LIMIT_POLICIES } from '../../infrastructure/rate-limit/rate-limit.policy';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/comment-mutation.dto';
import { CommentsQueryDto, DeleteCommentQueryDto } from './dto/comment-query.dto';

@ApiTags('comments')
@Controller('tokens/:tokenRef/comments')
export class TokenCommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Post()
  @HttpCode(201)
  @RateLimit(RATE_LIMIT_POLICIES.comment)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ operationId: 'createTokenComment' })
  async create(
    @Param('tokenRef') tokenRef: string,
    @Body() body: CreateCommentDto,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    const result = await this.comments.create(
      tokenRef,
      body,
      validateIdempotencyKey(idempotencyKey),
    );
    if (result.replayed) reply.header('Idempotency-Replayed', 'true');
    return result.value;
  }

  @Get()
  @ApiOperation({ operationId: 'listTokenComments' })
  list(@Param('tokenRef') tokenRef: string, @Query() query: CommentsQueryDto): Promise<unknown> {
    return this.comments.list(tokenRef, query);
  }
}

@ApiTags('comments')
@Controller('comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Delete(':id')
  @RateLimit(RATE_LIMIT_POLICIES.comment)
  @ApiOperation({ operationId: 'deleteComment' })
  delete(@Param('id') id: string, @Query() query: DeleteCommentQueryDto): Promise<unknown> {
    return this.comments.delete(id, query.walletAddress);
  }
}
