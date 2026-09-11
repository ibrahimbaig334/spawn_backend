import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { IndexerModule } from './indexer/indexer.module';
import { IndexerService } from './indexer/indexer.service';
import { validateEnvironment } from './config/environment';

/**
 * Indexer entrypoint: a headless Nest application context polling the chain and
 * maintaining the onchain projections. Run with PROCESS_ROLE=indexer or
 * `yarn start:indexer`.
 */

async function bootstrap(): Promise<void> {
  const environment = validateEnvironment(process.env);
  const logger = new Logger('Indexer');

  const app = await NestFactory.createApplicationContext(IndexerModule, {
    bufferLogs: true,
    logger: environment.NODE_ENV === 'production' ? ['error', 'warn', 'log'] : undefined,
  });
  app.enableShutdownHooks();

  const indexer = app.get(IndexerService);
  indexer.configure({
    chainId: environment.DEFAULT_CHAIN_ID,
    startBlock: environment.INDEXER_START_BLOCK ?? 0,
    confirmationBlocks: environment.INDEXER_CONFIRMATION_BLOCKS,
    blockBatch: environment.INDEXER_BLOCK_BATCH,
    pollMs: environment.INDEXER_POLL_MS,
    maxReorgDepth: environment.INDEXER_MAX_REORG_DEPTH,
  });

  const shutdown = () => {
    indexer.stop();
    void app.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await indexer.start();
  logger.log(`indexer running on chain ${environment.DEFAULT_CHAIN_ID}`);
}

void bootstrap();
