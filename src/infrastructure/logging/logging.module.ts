import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body',
            'res.body',
            '*.privateKey',
            '*.ciphertext',
            '*.authTag',
            '*.iv',
          ],
          censor: '[REDACTED]',
        },
        customProps: (request) => ({ requestId: request.id }),
      },
    }),
  ],
})
export class LoggingModule {}
