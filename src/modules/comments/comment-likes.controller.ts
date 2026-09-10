import { Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DomainException } from '../../common/http/domain.exception';
import { RateLimit } from '../../infrastructure/rate-limit/rate-limit.decorator';
import { RATE_LIMIT_POLICIES } from '../../infrastructure/rate-limit/rate-limit.policy';
import { CommentLikesService } from './comment-likes.service';
import { normalizeWallet } from './dto/comment-mutation.dto';

@ApiTags('comments')
@Controller('comments/:id/likes/:walletAddress')
export class CommentLikesController {
  constructor(private readonly likes: CommentLikesService) {}

  @Get()
  @ApiOperation({ operationId: 'getCommentLikeStatus' })
  status(@Param('id') id: string, @Param('walletAddress') walletAddress: string): Promise<unknown> {
    return this.likes.status(id, validatedWallet(walletAddress));
  }

  @Put()
  @RateLimit(RATE_LIMIT_POLICIES.commentLike)
  @ApiOperation({ operationId: 'likeComment' })
  like(@Param('id') id: string, @Param('walletAddress') walletAddress: string): Promise<unknown> {
    return this.likes.like(id, validatedWallet(walletAddress));
  }

  @Delete()
  @RateLimit(RATE_LIMIT_POLICIES.commentLike)
  @ApiOperation({ operationId: 'unlikeComment' })
  unlike(@Param('id') id: string, @Param('walletAddress') walletAddress: string): Promise<unknown> {
    return this.likes.unlike(id, validatedWallet(walletAddress));
  }
}

function validatedWallet(value: string): string {
  const wallet = normalizeWallet(value);
  if (typeof wallet !== 'string') {
    throw new DomainException(
      400,
      'INVALID_WALLET_ADDRESS',
      'walletAddress must be a nonzero EVM address',
    );
  }
  return wallet;
}
