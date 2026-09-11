import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { LaunchPrepareService, LaunchRelayService, LaunchQueryService } from './launch.services';
import { PrepareLaunchDto, RelayLaunchDto } from './dto/launch.dto';
import { LaunchStatusQueryDto } from './dto/launch-query.dto';
import { validateIdempotencyKey } from '../../common/http/idempotency-key';

@ApiTags('launch')
@Controller('launch')
export class LaunchController {
  constructor(
    private readonly prepareService: LaunchPrepareService,
    private readonly relayService: LaunchRelayService,
    private readonly queries: LaunchQueryService,
  ) {}

  @Post('prepare')
  @ApiOperation({ operationId: 'prepareLaunch' })
  async prepare(@Body() dto: PrepareLaunchDto) {
    return this.prepareService.prepare(dto);
  }

  @Post('relay')
  @HttpCode(202)
  @ApiOperation({ operationId: 'relayLaunch' })
  async relay(
    @Body() dto: RelayLaunchDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    validateIdempotencyKey(idempotencyKey);
    const result = await this.relayService.relay(dto, idempotencyKey!);
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
  async records(@Query() query: LaunchStatusQueryDto) {
    return this.queries.records(query);
  }
}
