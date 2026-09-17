import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OutboxDispatcher } from './infrastructure/queue/outbox-dispatcher';
import { PrismaService } from './infrastructure/database/prisma.service';
import { WorkerAppModule } from './worker-app.module';

/**
 * Worker: outbox dispatch + `leaderboard_daily` materialized-view refresh.
 * (The guide §3 recommends a 30s refresher sidecar; this process plays that role.)
 */

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  const logger = new Logger('OutboxWorker');
  const dispatcher = app.get(OutboxDispatcher);
  const prisma = app.get(PrismaService);

  const timer = setInterval(() => void dispatcher.dispatchBatch(), 1_000);
  timer.unref();

  const refresh = async () => {
    try {
      await prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_daily');
      await prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY pool_metrics_24h');
    } catch (error) {
      logger.warn(`rollup refresh failed: ${(error as Error).message}`);
    }
  };
  const leaderboardTimer = setInterval(() => void refresh(), 30_000);
  leaderboardTimer.unref();
  void refresh();

  app.enableShutdownHooks();
  process.once('SIGTERM', () => {
    clearInterval(timer);
    clearInterval(leaderboardTimer);
    void app.close();
  });
  logger.log('Outbox worker started (rollup refreshes every 30s)');
}

void bootstrap();
