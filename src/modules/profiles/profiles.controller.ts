import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RateLimit } from '../../infrastructure/rate-limit/rate-limit.decorator';
import { RATE_LIMIT_POLICIES } from '../../infrastructure/rate-limit/rate-limit.policy';
import { PortfolioQueryDto, ProfileTokensQueryDto } from './dto/profile-query.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfilesService } from './profiles.service';

@ApiTags('profiles')
@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get(':walletAddress')
  @ApiOperation({ operationId: 'getProfile' })
  find(@Param('walletAddress') walletAddress: string): Promise<unknown> {
    return this.profiles.find(walletAddress);
  }

  @Put(':walletAddress')
  @RateLimit(RATE_LIMIT_POLICIES.profileUpdate)
  @ApiOperation({ operationId: 'updateProfile' })
  update(
    @Param('walletAddress') walletAddress: string,
    @Body() body: UpdateProfileDto,
  ): Promise<unknown> {
    return this.profiles.update(walletAddress, body);
  }

  @Get(':walletAddress/tokens')
  @ApiOperation({ operationId: 'listProfileTokens' })
  tokens(
    @Param('walletAddress') walletAddress: string,
    @Query() query: ProfileTokensQueryDto,
  ): Promise<unknown> {
    return this.profiles.tokens(walletAddress, query);
  }

  @Get(':walletAddress/portfolio')
  @ApiOperation({ operationId: 'getProfilePortfolio' })
  portfolio(
    @Param('walletAddress') walletAddress: string,
    @Query() query: PortfolioQueryDto,
  ): Promise<unknown> {
    return this.profiles.portfolio(walletAddress, query);
  }
}
