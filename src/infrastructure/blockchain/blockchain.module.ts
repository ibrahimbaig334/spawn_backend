import { Global, Module, type Provider } from '@nestjs/common';
import { AppConfigModule } from '../../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { ChainClientFactory } from './chain-client.factory';
import { ProtocolReadService } from './protocol-read.service';
import { BlockchainRegistryService } from './blockchain-registry.service';
import { EthUsdOracle } from './eth-usd-oracle';

const providers: Provider[] = [
  ChainClientFactory,
  ProtocolReadService,
  BlockchainRegistryService,
  EthUsdOracle,
];

@Global()
@Module({
  imports: [AppConfigModule, DatabaseModule],
  providers,
  exports: [ChainClientFactory, ProtocolReadService, BlockchainRegistryService, EthUsdOracle],
})
export class BlockchainModule {}
