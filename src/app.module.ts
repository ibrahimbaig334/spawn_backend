import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { LoggingModule } from './infrastructure/logging/logging.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { CacheModule } from './infrastructure/cache/cache.module';
import { RateLimitModule } from './infrastructure/rate-limit/rate-limit.module';
import { BlockchainModule } from './infrastructure/blockchain/blockchain.module';
import { HealthModule } from './modules/health/health.module';
import { TokensModule } from './modules/tokens/tokens.module';
import { ProfilesModule } from './modules/profiles/profiles.module';
import { CommentsModule } from './modules/comments/comments.module';
import { LaunchModule } from './modules/launch/launch.module';
import { TradingModule } from './modules/trading/trading.module';
import { ProtocolModule } from './modules/protocol/protocol.module';
import { KeepersModule } from './modules/keepers/keepers.module';
import { RpcModule } from './modules/rpc/rpc.module';

@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    DatabaseModule,
    CacheModule,
    RateLimitModule,
    BlockchainModule,
    HealthModule,
    TokensModule,
    ProfilesModule,
    CommentsModule,
    LaunchModule,
    TradingModule,
    ProtocolModule,
    KeepersModule,
    RpcModule,
  ],
})
export class AppModule {}
