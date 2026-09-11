import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProtocolService } from './protocol.service';

@ApiTags('protocol')
@Controller('protocol')
export class ProtocolController {
  constructor(private readonly protocol: ProtocolService) {}

  @Get('addresses')
  @ApiOperation({ operationId: 'getProtocolAddresses' })
  addresses(@Query() query: { chainId?: number }) {
    return this.protocol.addresses(query);
  }

  @Get('economics')
  @ApiOperation({ operationId: 'getEconomicConfig' })
  economics(@Query() query: { chainId?: number }) {
    return this.protocol.economics(query);
  }

  @Get('plugins')
  @ApiOperation({ operationId: 'listPayoutPlugins' })
  plugins(@Query() query: { chainId?: number }) {
    return this.protocol.plugins(query);
  }

  @Get('governance/operations')
  @ApiOperation({ operationId: 'listGovernanceOperations' })
  operations(@Query() query: { chainId?: number; status?: string }) {
    return this.protocol.operations(query);
  }

  @Get('revenue')
  @ApiOperation({ operationId: 'getProtocolRevenue' })
  revenue(@Query() query: { chainId?: number }) {
    return this.protocol.revenue(query);
  }

  @Get('watermark')
  @ApiOperation({ operationId: 'getChainWatermark' })
  watermark(@Query() query: { chainId?: number }) {
    return this.protocol.watermark(query);
  }
}
