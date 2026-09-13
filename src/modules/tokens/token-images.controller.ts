import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RateLimit } from '../../infrastructure/rate-limit/rate-limit.decorator';
import { RATE_LIMIT_POLICIES } from '../../infrastructure/rate-limit/rate-limit.policy';
import { UploadImageDto } from './dto/upload-image.dto';
import { TokenImagesService } from './token-images.service';

@ApiTags('tokens')
@Controller('tokens')
export class TokenImagesController {
  constructor(private readonly images: TokenImagesService) {}

  @Post('images')
  @HttpCode(201)
  @RateLimit(RATE_LIMIT_POLICIES.general)
  @ApiOperation({ operationId: 'uploadTokenImage' })
  @ApiResponse({ status: 201, description: 'Logo pinned to IPFS; returns ipfs:// URI + gateway URL' })
  upload(@Body() body: UploadImageDto): Promise<unknown> {
    return this.images.uploadImage(body.filename, body.contentType, body.contentBase64);
  }
}
