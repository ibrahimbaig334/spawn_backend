import { Controller, Delete, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DomainException } from '../../common/http/domain.exception';
import { RateLimit } from '../../infrastructure/rate-limit/rate-limit.decorator';
import { RATE_LIMIT_POLICIES } from '../../infrastructure/rate-limit/rate-limit.policy';
import { WalletAuthGuard } from '../../infrastructure/auth/wallet-auth.guard';
import { CommentLikesService } from './comment-likes.service';
import { normalizeWallet } from './dto/comment-mutation.dto';

@ApiTags('comments')
@Controller('comments/:id/likes/:walletAddress')
export class CommentLikesController {
  constructor(private readonly likes: CommentLikesService) {}

  // Read-only: the URL wallet is the query subject, not an actor.
  @Get()
  @ApiOperation({ operationId: 'getCommentLikeStatus' })
  status(@Param('id') id: string, @Param('walletAddress') walletAddress: string): Promise<unknown> {
    return this.likes.status(id, validatedWallet(walletAddress));
  }

  // Mutations: the acting wallet comes from the verified session token.
  @Put()
  @UseGuards(WalletAuthGuard)
  @RateLimit(RATE_LIMIT_POLICIES.commentLike)
  @ApiOperation({ operationId: 'likeComment' })
  like(@Param('id') id: string, @Req() request: { walletAddress?: string }): Promise<unknown> {
    return this.likes.like(id, sessionWallet(request));
  }

  @Delete()
  @UseGuards(WalletAuthGuard)
  @RateLimit(RATE_LIMIT_POLICIES.commentLike)
  @ApiOperation({ operationId: 'unlikeComment' })
  unlike(@Param('id') id: string, @Req() request: { walletAddress?: string }): Promise<unknown> {
    return this.likes.unlike(id, sessionWallet(request));
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

function sessionWallet(request: { walletAddress?: string }): string {
  if (!request.walletAddress) {
    throw new DomainException(401, 'SESSION_INVALID', 'authenticated wallet missing');
  }
  return request.walletAddress;
}
