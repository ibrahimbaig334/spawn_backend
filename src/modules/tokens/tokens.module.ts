import { Module } from '@nestjs/common';
import { APP_ENVIRONMENT } from '../../config/config.constants';
import type { Environment } from '../../config/environment';
import { FeaturedTokensService } from './featured-tokens.service';
import { PinataService } from './storage/pinata-client';
import { PinataTokenMetadataStorage } from './storage/pinata-token-metadata-storage';
import { ThirdwebTokenMetadataStorage } from './storage/thirdweb-token-metadata-storage';
import { TOKEN_METADATA_STORAGE } from './storage/token-metadata-storage';
import { TokenCreationService } from './token-creation.service';
import { TokenImagesController } from './token-images.controller';
import { TokenImagesService } from './token-images.service';
import { TokenQueryService } from './token-query.service';
import { TokensController } from './tokens.controller';

@Module({
  controllers: [TokensController, TokenImagesController],
  providers: [
    TokenCreationService,
    TokenQueryService,
    FeaturedTokensService,
    PinataService,
    TokenImagesService,
    {
      provide: TOKEN_METADATA_STORAGE,
      useFactory: (environment: Environment, pinata: PinataService) =>
        environment.METADATA_STORAGE_DRIVER === 'thirdweb'
          ? new ThirdwebTokenMetadataStorage(environment)
          : new PinataTokenMetadataStorage(pinata),
      inject: [APP_ENVIRONMENT, PinataService],
    },
  ],
  exports: [TokenCreationService, TokenQueryService, TOKEN_METADATA_STORAGE],
})
export class TokensModule {}
