import { Global, Module } from '@nestjs/common';

import { type Env, loadEnv } from './env';

/**
 * Injection token for the validated env shape. A symbol (not a string) so a
 * typo at the consumer's `@Inject(...)` site is a TS error.
 */
export const ENV_TOKEN = Symbol('WORKER_STRIPE_RECONCILIATION_ENV');

/**
 * Provides the validated `Env` shape via DI. `@Global()` so feature modules
 * don't re-import this from every wiring point. The env is loaded at
 * module-construction time so a misconfigured pod fails to start
 * (CLAUDE.md §17.11).
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
