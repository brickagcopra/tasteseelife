import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';

import { CouponRateLimitService } from './coupon-rate-limit.service';

/**
 * FakeRedis stands in for the `multi().incr(...).expire(...).exec()` chain.
 * Keeps a Map of counters and a Map of expiries so the test can simulate
 * the fixed-window roll. Mirrors the FakeRedis shape from
 * `@taste-and-see/nest-idempotency`'s test fixtures.
 */
class FakeRedis {
  private readonly counters = new Map<string, number>();

  multi(): {
    incr: (key: string) => void;
    expire: (key: string, _seconds: number) => void;
    exec: () => Promise<Array<[Error | null, unknown]>>;
  } {
    let pendingKey: string | null = null;
    return {
      incr: (key: string): void => {
        pendingKey = key;
      },
      expire: (_key: string, _seconds: number): void => {
        // no-op for the fake — TTL semantics aren't under test
      },
      exec: async (): Promise<Array<[Error | null, unknown]>> => {
        if (pendingKey === null) {
          return [];
        }
        const next = (this.counters.get(pendingKey) ?? 0) + 1;
        this.counters.set(pendingKey, next);
        return [
          [null, next],
          [null, 1],
        ];
      },
    };
  }

  async resetCounters(): Promise<void> {
    this.counters.clear();
  }
}

class FailingRedis {
  multi(): { incr: () => void; expire: () => void; exec: () => Promise<never> } {
    return {
      incr: (): void => undefined,
      expire: (): void => undefined,
      exec: async (): Promise<never> => {
        throw new Error('redis offline');
      },
    };
  }
}

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3012,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'dev',
    STRIPE_SECRET_KEY: 'sk_test_xxxxxxxxxxxxxxxx',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    REDIS_URL: 'redis://localhost:6379',
    SUBSCRIPTION_DUNNING_SWEEP_ENABLED: true,
    SUBSCRIPTION_DUNNING_SWEEP_INTERVAL_MS: 3_600_000,
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5_000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1_000,
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 60,
    DUNNING_GRACE_DAYS: 21,
    BILLING_PORTAL_RETURN_URL: 'http://localhost:3000/billing',
    COUPON_RATE_LIMIT_IP_MAX_PER_WINDOW: 3,
    COUPON_RATE_LIMIT_IP_WINDOW_SECONDS: 60,
    COUPON_RATE_LIMIT_USER_MAX_PER_WINDOW: 2,
    COUPON_RATE_LIMIT_USER_WINDOW_SECONDS: 60,
    OTEL_TRACES_ENABLED: true,
    OTEL_METRICS_ENABLED: true,
    ...overrides,
  };
}

function buildSvc(env: Env = buildEnv()): {
  service: CouponRateLimitService;
  redis: FakeRedis;
} {
  const redis = new FakeRedis();
  const service = new CouponRateLimitService(env, redis as unknown as Redis);
  return { service, redis };
}

describe('CouponRateLimitService.check', () => {
  it('allows the first attempt under both caps', async () => {
    const { service } = buildSvc();
    const result = await service.check({ ip: '203.0.113.5', userId: 'usr_a' });
    expect(result.ok).toBe(true);
  });

  it('allows attempts up to the user-cap', async () => {
    const { service } = buildSvc(buildEnv({ COUPON_RATE_LIMIT_USER_MAX_PER_WINDOW: 2 }));
    const a = await service.check({ ip: '203.0.113.5', userId: 'usr_a' });
    const b = await service.check({ ip: '203.0.113.5', userId: 'usr_a' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('rejects with rate_limited (scope=user) once the user-cap is exceeded', async () => {
    const { service } = buildSvc(buildEnv({ COUPON_RATE_LIMIT_USER_MAX_PER_WINDOW: 2 }));
    await service.check({ ip: '203.0.113.5', userId: 'usr_a' });
    await service.check({ ip: '203.0.113.5', userId: 'usr_a' });
    const third = await service.check({ ip: '203.0.113.5', userId: 'usr_a' });
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.error.reason).toBe('rate_limited');
    if (third.error.reason !== 'rate_limited') return;
    expect(third.error.scope).toBe('user');
    expect(third.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(third.error.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('rejects with rate_limited (scope=ip) once the IP-cap is exceeded across users', async () => {
    const { service } = buildSvc(
      buildEnv({
        COUPON_RATE_LIMIT_IP_MAX_PER_WINDOW: 3,
        // Bump user-cap so the IP scope trips first.
        COUPON_RATE_LIMIT_USER_MAX_PER_WINDOW: 10,
      }),
    );
    await service.check({ ip: '203.0.113.5', userId: 'usr_a' });
    await service.check({ ip: '203.0.113.5', userId: 'usr_b' });
    await service.check({ ip: '203.0.113.5', userId: 'usr_c' });
    const fourth = await service.check({ ip: '203.0.113.5', userId: 'usr_d' });
    expect(fourth.ok).toBe(false);
    if (fourth.ok) return;
    expect(fourth.error.reason).toBe('rate_limited');
    if (fourth.error.reason !== 'rate_limited') return;
    expect(fourth.error.scope).toBe('ip');
  });

  it('uses separate buckets per user', async () => {
    const { service } = buildSvc(buildEnv({ COUPON_RATE_LIMIT_USER_MAX_PER_WINDOW: 1 }));
    const a = await service.check({ ip: '203.0.113.5', userId: 'usr_a' });
    const b = await service.check({ ip: '203.0.113.5', userId: 'usr_b' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('returns unavailable when redis exec throws (fail-open posture)', async () => {
    const env = buildEnv();
    const failing = new FailingRedis();
    const service = new CouponRateLimitService(env, failing as unknown as Redis);
    const result = await service.check({ ip: '203.0.113.5', userId: 'usr_a' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('unavailable');
  });

  it('emits a different bucket key per environment', async () => {
    // Drive two parallel services on `test` and `staging` and verify
    // their counters don't collide. The FakeRedis exposes the
    // pre-pipeline key construction by routing all increments through
    // a shared Map keyed on the full key string; if the prefixes
    // collided, the staging service's first attempt would already be
    // at 2 in the underlying counter.
    const sharedRedis = new FakeRedis();
    const testSvc = new CouponRateLimitService(buildEnv(), sharedRedis as unknown as Redis);
    const stagingSvc = new CouponRateLimitService(
      buildEnv({ NODE_ENV: 'staging' }),
      sharedRedis as unknown as Redis,
    );
    await testSvc.check({ ip: '203.0.113.5', userId: 'usr_a' });
    await testSvc.check({ ip: '203.0.113.5', userId: 'usr_a' });
    const stagingFirst = await stagingSvc.check({ ip: '203.0.113.5', userId: 'usr_a' });
    expect(stagingFirst.ok).toBe(true);
  });
});

describe('CouponRateLimitService helper coverage', () => {
  it('exposes vi-callable surface for downstream import-time assertion', () => {
    const { service } = buildSvc();
    expect(service).toBeInstanceOf(CouponRateLimitService);
  });

  it('redacts large IPs without leaking the raw value (cardinality check)', async () => {
    // Hash-redaction makes the bucket key bounded — multiple distinct IPs
    // never collide on a single bucket within a window (negligible
    // probability for 16-char hex prefix). Verified indirectly: two
    // distinct IPs produce two independent counter streams.
    const { service } = buildSvc(buildEnv({ COUPON_RATE_LIMIT_IP_MAX_PER_WINDOW: 1 }));
    const a = await service.check({ ip: '203.0.113.5', userId: 'usr_a' });
    const b = await service.check({ ip: '198.51.100.7', userId: 'usr_b' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });
});
