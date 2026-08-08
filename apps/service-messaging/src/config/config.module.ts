import { Global, Module } from '@nestjs/common';

import { loadEnv, type Env } from './env';

export const ENV_TOKEN = Symbol.for('@taste-and-see/service-messaging:env');

/**
 * Provides the validated `Env` object to every module via DI.
 *
 * Resolves at provider-construction time so a misconfigured environment
 * fails the bootstrap, not the first request.
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV_TOKEN,
      useFactory: (): Env => loadEnv(),
    },
  ],
  exports: [ENV_TOKEN],
})
export class AppConfigModule {}
