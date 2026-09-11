import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { KeepersService } from './keepers.service';

@ApiTags('keepers')
@Controller('keepers')
export class KeepersController {
  constructor(private readonly keepers: KeepersService) {}

  @Get('jobs')
  @ApiOperation({ operationId: 'listKeeperJobs' })
  jobs(@Query() query: { chainId?: number; kind?: string; limit?: number }) {
    return this.keepers.jobs(query);
  }
}
