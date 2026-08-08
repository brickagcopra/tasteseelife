import { Global, Module } from '@nestjs/common';

import { type Env, loadEnv } from './env';

/**
 * Injection token for the validated env shape. Tokens are symbols not
 * strings so a typo at the consumer's `@Inject(...)` site is a TS
 * error.
 */
export const ENV_TOKEN = Symbol('WORKER_OUTBOX_RELAY_ENV');

/**
 * Provides the validated `Env` shape via DI. `@Global()` so feature
 * modules don't have to re-import this from every wiring point.
 *
 * The env is loaded at module-construction time — earlier than first
 * use — so a misconfigured pod fails to start (CLAUDE.md §17.11).
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
