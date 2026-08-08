import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

import { CouponsController } from './controllers/coupons.controller';
import { CouponMetrics } from './services/coupon-metrics';
import {
  COUPON_RATE_LIMIT_REDIS_TOKEN,
  CouponRateLimitService,
} from './services/coupon-rate-limit.service';
import { CouponsService } from './services/coupons.service';

/**
 * Coupons bounded module (TS-043) — owns the coupon catalog,
 * validation gate, redemption persistence, and the Redis-backed
 * abuse rate-limiter that defends `POST /api/v1/coupons/validate`.
 *
 * The module wires a DEDICATED ioredis client (separate from
 * `@taste-and-see/nest-idempotency`'s internal client) for the
 * rate-limiter so the two surfaces don't share a connection pool;
 * an idempotency-cache hot path shouldn't be slowed by rate-limiter
 * INCR storms. Both clients connect to the same `REDIS_URL` so the
 * cluster-side semantics are identical.
 *
 * **Lifecycle.** `OnApplicationShutdown` quits the rate-limiter
 * client on Nest shutdown so the connection drains cleanly under
 * Kubernetes pod-termination. Mirrors the pattern in the idempotency
 * module's internal client.
 *
 * Provides `CouponsService` so other modules (notably
 * `SubscriptionsModule`) can inject it for the create-with-coupon
 * orchestration path.
 */
@Module({
  controllers: [CouponsController],
  providers: [
    CouponsService,
    CouponRateLimitService,
    CouponMetrics,
    {
      provide: COUPON_RATE_LIMIT_REDIS_TOKEN,
      inject: [ENV_TOKEN],
      useFactory: (env: Env): Redis =>
        new Redis(env.REDIS_URL, {
          // Same posture as IdempotencyModule's client: fail-fast
          // instead of queuing commands when Redis is down (CLAUDE.md
          // §4.3 — caches best-effort).
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          lazyConnect: false,
          keyPrefix: '',
          // Connection name surfaces in `CLIENT LIST` for ops triage.
          connectionName: 'service-subscription-coupon-rate-limit',
        }),
    },
  ],
  exports: [CouponsService],
})
export class CouponsModule implements OnApplicationShutdown {
  constructor(@Inject(COUPON_RATE_LIMIT_REDIS_TOKEN) private readonly rateLimitRedis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.rateLimitRedis.status !== 'end') {
      await this.rateLimitRedis.quit().catch(() => {
        /* swallow — pod is going away */
      });
    }
  }
}
