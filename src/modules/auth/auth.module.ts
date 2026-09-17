import { Body, Controller, Get, Global, Module, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { RateLimit } from '../../infrastructure/rate-limit/rate-limit.decorator';
import { RATE_LIMIT_POLICIES } from '../../infrastructure/rate-limit/rate-limit.policy';
import { WalletAuthService } from '../../infrastructure/auth/wallet-auth.service';
import { DomainException } from '../../common/http/domain.exception';

export class NonceDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{40}$/u)
  walletAddress!: string;
}

export class VerifyDto extends NonceDto {
  @IsString()
  nonce!: string;

  @IsString()
  signature!: string;

  @IsString()
  message!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: WalletAuthService) {}

  @Get('config')
  @ApiOperation({ operationId: 'getAuthConfig' })
  config() {
    return { scheme: 'siwe-lite', sessionTtlSeconds: 60 * 60 * 24 * 7 };
  }

  @Post('nonce')
  @RateLimit(RATE_LIMIT_POLICIES.comment)
  @ApiOperation({ operationId: 'issueAuthNonce' })
  nonce(@Body() body: NonceDto) {
    return this.auth.issueNonce(body.walletAddress);
  }

  @Post('verify')
  @RateLimit(RATE_LIMIT_POLICIES.comment)
  @ApiOperation({ operationId: 'verifyAuthSignature' })
  verify(@Body() body: VerifyDto) {
    if (!/^[\s\S]{20,2000}$/u.test(body.message)) {
      throw new DomainException(400, 'INVALID_MESSAGE', 'message is required');
    }
    return this.auth.verify(body.walletAddress, body.nonce, body.signature, body.message);
  }
}

@Global()
@Module({
  controllers: [AuthController],
  providers: [WalletAuthService],
  exports: [WalletAuthService],
})
export class AuthModule {}
