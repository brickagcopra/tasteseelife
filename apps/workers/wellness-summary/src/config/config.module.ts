import { Global, Module } from '@nestjs/common';

import { type Env, loadEnv } from './env';

/**
 * Injection token for the validated env shape. A symbol (not a string)
 * so a typo at a consumer's `@Inject(...)` site is a compile error.
 */
export const ENV_TOKEN = Symbol('WORKER_WELLNESS_SUMMARY_ENV');

/**
 * Provides the validated `Env` via DI. `@Global()` so feature modules
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
