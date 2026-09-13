import helmet from '@fastify/helmet';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/http/problem-details.filter';
import { ResponseEnvelopeInterceptor } from './common/http/response-envelope.interceptor';
import { NumericSerializationInterceptor } from './common/serialization/numeric-serialization.interceptor';
import { TrimStringsPipe } from './common/validation/trim-strings.pipe';
import type { Environment } from './config/environment';
import { validateEnvironment } from './config/environment';
import { APP_ENVIRONMENT } from './config/config.constants';

async function bootstrap(): Promise<void> {
  const preliminaryEnvironment = validateEnvironment(process.env);
  const adapter = new FastifyAdapter({
    // 8MB: logo uploads arrive as base64 JSON at POST /tokens/images (4.3MB
    // file cap + ~33% base64 overhead); all other bodies stay tiny.
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: preliminaryEnvironment.trustedProxy,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });
  const environment = app.get<Environment>(APP_ENVIRONMENT);

  await app.register(helmet);
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: environment.corsOrigins, credentials: true });
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new TrimStringsPipe(),
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  );
  app.useGlobalInterceptors(
    new NumericSerializationInterceptor(),
    new ResponseEnvelopeInterceptor(),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());

  const instance = adapter.getInstance();
  instance.addHook('onRequest', (request, reply, done) => {
    reply.header('X-Request-Id', request.id);
    done();
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Spawn API')
    .setDescription('Offchain launchpad API merged with committed onchain projections')
    .setVersion('1.0.0')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  document.openapi = '3.0.3';
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: '/api/openapi.json' });

  await app.listen(environment.PORT, '0.0.0.0');
}

void bootstrap();
