import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

/**
 * Module-scoped Redis client used by:
 *
 *   - `RateLimitService` — sliding-window check + record.
 *   - `HealthController.readiness` — PING for the readyz probe.
 *   - Future TS-140-followup-1+ — Idempotency-Key cache once the
 *     gateway grows write-proxy paths.
 *
 * Lazy-connect mode: the client connects on first command. Means the
 * Nest bootstrap completes even when Redis is briefly unavailable —
 * readyz reports `redis: 'unavailable'` until the cluster recovers,
 * and individual commands fail-open per CLAUDE.md §4.3.
 *
 * `maxRetriesPerRequest: 3` bounds the in-process retry loop so a
 * stuck Redis doesn't drag every gateway request into a multi-second
 * timeout — fail fast, surface as `unavailable`, proceed.
 */
export const GATEWAY_REDIS_TOKEN = Symbol.for('@taste-and-see/api-gateway:redis');

@Global()
@Module({
  providers: [
    {
      provide: GATEWAY_REDIS_TOKEN,
      useFactory: (env: Env): Redis =>
        new Redis(env.REDIS_URL, {
          lazyConnect: true,
          enableAutoPipelining: false,
          maxRetriesPerRequest: 3,
        }),
      inject: [ENV_TOKEN],
    },
  ],
  exports: [GATEWAY_REDIS_TOKEN],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject(GATEWAY_REDIS_TOKEN) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.redis.quit();
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        'redis quit failed during shutdown',
      );
    }
  }
}
