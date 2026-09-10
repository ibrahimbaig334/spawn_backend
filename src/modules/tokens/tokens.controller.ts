import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { validateIdempotencyKey } from '../../common/http/idempotency-key';
import { RateLimit } from '../../infrastructure/rate-limit/rate-limit.decorator';
import { RATE_LIMIT_POLICIES } from '../../infrastructure/rate-limit/rate-limit.policy';
import { CreateTokenDto } from './dto/create-token.dto';
import { TokenDetailQueryDto, TokenTradesQueryDto } from './dto/token-detail-query.dto';
import { FeaturedTokensQueryDto, TokenListQueryDto } from './dto/token-list-query.dto';
import { TokenCandlesQueryDto, TokenMilestonesQueryDto } from './dto/token-projection-query.dto';
import { FeaturedTokensService } from './featured-tokens.service';
import { TokenCreationService } from './token-creation.service';
import { TokenQueryService } from './token-query.service';

@ApiTags('tokens')
@Controller('tokens')
export class TokensController {
  constructor(
    private readonly creation: TokenCreationService,
    private readonly queries: TokenQueryService,
    private readonly featuredTokens: FeaturedTokensService,
  ) {}

  @Get()
  @ApiOperation({ operationId: 'listTokens' })
  list(@Query() query: TokenListQueryDto): Promise<unknown> {
    return this.queries.list(query);
  }

  @Get('featured')
  @ApiOperation({ operationId: 'getFeaturedTokens' })
  featured(@Query() query: FeaturedTokensQueryDto): Promise<unknown> {
    return this.featuredTokens.find(query.chainId);
  }

  @Post()
  @HttpCode(201)
  @RateLimit(RATE_LIMIT_POLICIES.tokenCreate)
  @ApiOperation({ operationId: 'createToken' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 201, description: 'Token created with uploaded IPFS metadata' })
  async create(
    @Body() body: CreateTokenDto,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    const result = await this.creation.create(body, validateIdempotencyKey(idempotencyKey));
    if (result.replayed) reply.header('Idempotency-Replayed', 'true');
    reply.header('Location', `/api/v1/tokens/${result.value.tokenId}`);
    return result.value;
  }

  @Get(':tokenRef/trades')
  @ApiOperation({ operationId: 'listTokenTrades' })
  trades(
    @Param('tokenRef') tokenRef: string,
    @Query() query: TokenTradesQueryDto,
  ): Promise<unknown> {
    return this.queries.trades(tokenRef, query);
  }

  @Get(':tokenRef/candles')
  @ApiOperation({ operationId: 'listTokenCandles' })
  candles(
    @Param('tokenRef') tokenRef: string,
    @Query() query: TokenCandlesQueryDto,
  ): Promise<unknown> {
    return this.queries.candles(tokenRef, query);
  }

  @Get(':tokenRef/milestones')
  @ApiOperation({ operationId: 'listTokenMilestones' })
  milestones(
    @Param('tokenRef') tokenRef: string,
    @Query() query: TokenMilestonesQueryDto,
  ): Promise<unknown> {
    return this.queries.milestones(tokenRef, query);
  }

  @Get(':tokenRef')
  @ApiOperation({ operationId: 'getToken' })
  detail(
    @Param('tokenRef') tokenRef: string,
    @Query() query: TokenDetailQueryDto,
  ): Promise<unknown> {
    return this.queries.detail(tokenRef, query);
  }
}
