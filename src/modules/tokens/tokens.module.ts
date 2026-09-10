import { Module } from '@nestjs/common';
import { FeaturedTokensService } from './featured-tokens.service';
import { ThirdwebTokenMetadataStorage } from './storage/thirdweb-token-metadata-storage';
import { TOKEN_METADATA_STORAGE } from './storage/token-metadata-storage';
import { TokenCreationService } from './token-creation.service';
import { TokenQueryService } from './token-query.service';
import { TokensController } from './tokens.controller';

@Module({
  controllers: [TokensController],
  providers: [
    TokenCreationService,
    TokenQueryService,
    FeaturedTokensService,
    { provide: TOKEN_METADATA_STORAGE, useClass: ThirdwebTokenMetadataStorage },
  ],
  exports: [TokenCreationService, TokenQueryService],
})
export class TokensModule {}
