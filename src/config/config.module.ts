import { Global, Module } from '@nestjs/common';
import { APP_ENVIRONMENT } from './config.constants';
import { validateEnvironment } from './environment';

@Global()
@Module({
  providers: [
    {
      provide: APP_ENVIRONMENT,
      useFactory: () => validateEnvironment(process.env),
    },
  ],
  exports: [APP_ENVIRONMENT],
})
export class AppConfigModule {}
