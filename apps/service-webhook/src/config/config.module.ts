import { Global, Module } from '@nestjs/common';

import { loadEnv, type Env } from './env';

export const ENV_TOKEN = Symbol.for('@taste-and-see/service-webhook:env');

/**
 * Provides the validated `Env` object to every module via DI.
 *
 * Resolves at provider-construction time so a misconfigured environment
 * fails the bootstrap, not the first request. Critical for this service
 * specifically — see `env.ts` doc-comment for why a missing
 * `STRIPE_WEBHOOK_SECRET` must fail-fast and never be silently defaulted.
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
