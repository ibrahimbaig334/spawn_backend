import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { CommentsModule } from './modules/comments/comments.module';
import { CacheModule } from './infrastructure/cache/cache.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { LoggingModule } from './infrastructure/logging/logging.module';
import { RateLimitModule } from './infrastructure/rate-limit/rate-limit.module';
import { HealthModule } from './modules/health/health.module';
import { ProfilesModule } from './modules/profiles/profiles.module';
import { TokensModule } from './modules/tokens/tokens.module';

@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    DatabaseModule,
    CacheModule,
    RateLimitModule,
    HealthModule,
    TokensModule,
    ProfilesModule,
    CommentsModule,
  ],
})
export class AppModule {}
