import { Module } from '@nestjs/common';
import { CacheModule } from '../../infrastructure/cache/cache.module';
import { HealthController } from './health.controller';

@Module({
  imports: [CacheModule],
  controllers: [HealthController],
})
export class HealthModule {}
