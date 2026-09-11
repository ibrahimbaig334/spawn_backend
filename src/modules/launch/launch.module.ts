import { Module } from '@nestjs/common';
import { TokensModule } from '../tokens/tokens.module';
import { LaunchController } from './launch.controller';
import { LaunchPrepareService, LaunchRelayService, LaunchQueryService } from './launch.services';

@Module({
  imports: [TokensModule],
  controllers: [LaunchController],
  providers: [LaunchPrepareService, LaunchRelayService, LaunchQueryService],
  exports: [LaunchQueryService],
})
export class LaunchModule {}
