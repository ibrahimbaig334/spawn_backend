import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { CacheModule } from './infrastructure/cache/cache.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { LoggingModule } from './infrastructure/logging/logging.module';
import { QueueModule } from './infrastructure/queue/queue.module';

@Module({
  imports: [AppConfigModule, LoggingModule, DatabaseModule, CacheModule, QueueModule],
})
export class WorkerAppModule {}
