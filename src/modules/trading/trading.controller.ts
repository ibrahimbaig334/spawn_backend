import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TradingService } from './trading.service';
import { QuoteQueryDto, DepthQueryDto } from './dto/trading-query.dto';

@ApiTags('trading')
@Controller()
export class TradingController {
  constructor(private readonly trading: TradingService) {}

  @Get('tokens/:tokenRef/price')
  @ApiOperation({ operationId: 'getTokenPrice' })
  price(@Param('tokenRef') tokenRef: string, @Query() query: { chainId?: number }) {
    return this.trading.price(tokenRef, query);
  }

  @Get('tokens/:tokenRef/quote')
  @ApiOperation({ operationId: 'quoteTokenSwap' })
  quote(@Param('tokenRef') tokenRef: string, @Query() query: QuoteQueryDto) {
    return this.trading.quote(tokenRef, query);
  }

  @Get('tokens/:tokenRef/depth')
  @ApiOperation({ operationId: 'getTokenDepth' })
  depth(@Param('tokenRef') tokenRef: string, @Query() query: DepthQueryDto) {
    return this.trading.depth(tokenRef, query);
  }
}
