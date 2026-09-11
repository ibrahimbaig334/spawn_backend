import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { LoggingModule } from '../infrastructure/logging/logging.module';
import { DatabaseModule } from '../infrastructure/database/database.module';
import { BlockchainModule } from '../infrastructure/blockchain/blockchain.module';
import { BlockIngesterService } from './block-ingester.service';
import { ProjectionApplier } from './projection-applier';
import { MarketProjector } from './market-projector';
import { IndexerService } from './indexer.service';

/**
 * The indexer process module. The entrypoint (src/indexer.ts) builds an app
 * context of this module, configures IndexerService from the environment, and runs
 * the poll loop. Database/cache/blockchain infrastructure comes in via the global
 * modules.
 */
@Module({
  imports: [AppConfigModule, LoggingModule, DatabaseModule, BlockchainModule],
  providers: [BlockIngesterService, ProjectionApplier, MarketProjector, IndexerService],
  exports: [IndexerService],
})
export class IndexerModule {}
