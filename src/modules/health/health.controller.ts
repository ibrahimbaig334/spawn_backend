import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { CACHE_MANAGER } from '../../infrastructure/cache/cache.constants';
import type { DomainCachePort } from '../../infrastructure/cache/domain-cache.port';
import { PrismaService } from '../../infrastructure/database/prisma.service';

@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: DomainCachePort,
  ) {}

  @Get('live')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness(): Promise<Record<string, unknown>> {
    const checks: Record<string, 'up' | 'down'> = { database: 'down', redis: 'down' };
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch {
      throw this.unavailable(checks);
    }

    try {
      await this.cache.ping();
      checks.redis = 'up';
      return { status: 'ok', checks };
    } catch {
      throw this.unavailable(checks);
    }
  }

  private unavailable(checks: Record<string, 'up' | 'down'>): HttpException {
    return new HttpException(
      { code: 'DEPENDENCY_UNAVAILABLE', message: 'A required dependency is unavailable', checks },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
