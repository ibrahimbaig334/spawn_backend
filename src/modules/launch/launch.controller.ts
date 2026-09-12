import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { LaunchPrepareService, LaunchRelayService, LaunchQueryService } from './launch.services';
import { PrepareLaunchDto, RelayLaunchDto } from './dto/launch.dto';
import { LaunchRecordsQueryDto } from './dto/launch-query.dto';
import { validateIdempotencyKey } from '../../common/http/idempotency-key';
import { RateLimit } from '../../infrastructure/rate-limit/rate-limit.decorator';
import { RATE_LIMIT_POLICIES } from '../../infrastructure/rate-limit/rate-limit.policy';

/**
 * Launch flow. Creators never sign: the protocol's on-chain trustedOperator —
 * operated by this backend — signs every relayed LaunchConfig; the backend then
 * broadcasts the launch and the indexer binds the Launched event by configHash.
 */

@ApiTags('launch')
@Controller('launch')
export class LaunchController {
  constructor(
    private readonly prepareService: LaunchPrepareService,
    private readonly relayService: LaunchRelayService,
    private readonly queries: LaunchQueryService,
  ) {}

  @Post('prepare')
  @RateLimit(RATE_LIMIT_POLICIES.tokenCreate)
  @ApiOperation({ operationId: 'prepareLaunch' })
  async prepare(@Body() dto: PrepareLaunchDto) {
    return this.prepareService.prepare(dto);
  }

  @Post('relay')
  @HttpCode(202)
  @RateLimit(RATE_LIMIT_POLICIES.tokenCreate)
  @ApiOperation({ operationId: 'relayLaunch' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({
    status: 202,
    description: 'Operator-signed launch broadcast; confirm via GET record',
  })
  async relay(
    @Body() dto: RelayLaunchDto,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const key = validateIdempotencyKey(idempotencyKey);
    const result = await this.relayService.relay(dto.launchId, key);
    if (result.replayed) reply.header('Idempotency-Replayed', 'true');
    return result.response;
  }

  @Get('records/:launchId')
  @ApiOperation({ operationId: 'getLaunchRecord' })
  async record(@Param('launchId') launchId: string) {
    return this.queries.record(launchId);
  }

  @Get('records')
  @ApiOperation({ operationId: 'listLaunchRecords' })
  async records(@Query() query: LaunchRecordsQueryDto) {
    return this.queries.records(query);
  }
}
