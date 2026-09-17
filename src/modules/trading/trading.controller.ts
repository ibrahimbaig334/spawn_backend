import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TradingService } from './trading.service';
import { QuoteQueryDto, DepthQueryDto, PriceQueryDto, WalletTradesQueryDto } from './dto/trading-query.dto';

@ApiTags('trading')
@Controller()
export class TradingController {
  constructor(private readonly trading: TradingService) {}

  @Get('tokens/:tokenRef/price')
  @ApiOperation({ operationId: 'getTokenPrice' })
  price(@Param('tokenRef') tokenRef: string, @Query() query: PriceQueryDto) {
    return this.trading.price(tokenRef, query);
  }

  @Get('tokens/:tokenRef/quote')
  @ApiOperation({ operationId: 'quoteTokenSwap' })
  quote(@Param('tokenRef') tokenRef: string, @Query() query: QuoteQueryDto) {
    return this.trading.quote(tokenRef, query);
  }

  @Get('tokens/:tokenRef/max-buy')
  @ApiOperation({ operationId: 'getTokenMaxBuy' })
  maxBuy(@Param('tokenRef') tokenRef: string) {
    return this.trading.maxBuy(tokenRef);
  }

  @Get('wallets/:wallet/trades')
  @ApiOperation({ operationId: 'getWalletTrades' })
  walletTrades(
    @Param('wallet') wallet: string,
    @Query() query: WalletTradesQueryDto,
  ) {
    return this.trading.walletTrades(wallet, query.page, query.limit ?? 50, query.chainId);
  }

  @Get('wallets/:wallet/pnl')
  @ApiOperation({ operationId: 'getWalletPnl' })
  pnl(@Param('wallet') wallet: string) {
    return this.trading.walletPnl(wallet);
  }

  @Get('tokens/:tokenRef/holders')
  @ApiOperation({ operationId: 'getTokenHolders' })
  holders(@Param('tokenRef') tokenRef: string) {
    return this.trading.holders(tokenRef);
  }

  @Get('tokens/:tokenRef/depth')
  @ApiOperation({ operationId: 'getTokenDepth' })
  depth(@Param('tokenRef') tokenRef: string, @Query() query: DepthQueryDto) {
    return this.trading.depth(tokenRef, query);
  }
}
