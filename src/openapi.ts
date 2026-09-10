import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppModule } from './app.module';

async function buildDocument(): Promise<string> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
    preview: true,
  });
  app.setGlobalPrefix('api/v1');
  const config = new DocumentBuilder()
    .setTitle('Spawn API')
    .setDescription('Offchain launchpad API merged with committed onchain projections')
    .setVersion('1.0.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  document.openapi = '3.0.3';
  document.info.version = '1.0.0';
  await app.close();
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function generate(): Promise<void> {
  const outputPath = resolve('openapi.json');
  const output = await buildDocument();
  if (process.argv.includes('--check')) {
    const committed = await readFile(outputPath, 'utf8').catch(() => '');
    if (committed !== output) {
      throw new Error('openapi.json is out of date; run pnpm openapi:generate');
    }
    return;
  }
  await writeFile(outputPath, output, 'utf8');
}

void generate().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
