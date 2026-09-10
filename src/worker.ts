import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OutboxDispatcher } from './infrastructure/queue/outbox-dispatcher';
import { WorkerAppModule } from './worker-app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  const logger = new Logger('OutboxWorker');
  const dispatcher = app.get(OutboxDispatcher);
  const timer = setInterval(() => void dispatcher.dispatchBatch(), 1_000);
  timer.unref();

  app.enableShutdownHooks();
  process.once('SIGTERM', () => {
    clearInterval(timer);
    void app.close();
  });
  logger.log('Outbox worker started');
}

void bootstrap();
