import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';

import { IpCircuitBreakerService } from './ip-circuit-breaker.service';

/**
 * FakeRedis stands in for the small ioredis surface the service
 * actually uses: `get(key)` and `multi().incr(key).expire(...).exec()`.
 * Keeps a Map of bucket counters so tests can simulate the fixed-
 * window roll without touching wall-clock time. Mirrors the pattern
 * from `coupon-rate-limit.service.test.ts` and the FakeRedis used in
 * `@taste-and-see/nest-idempotency`'s test fixtures.
 */
class FakeRedis {
  readonly counters = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    const value = this.counters.get(key);
    return value === undefined ? null : String(value);
  }

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
}

/**
 * FailingRedis simulates a Redis outage on every command. Used to
 * verify the fail-open posture documented in the service header.
 */
class FailingRedis {
  async get(_key: string): Promise<never> {
    throw new Error('redis offline');
  }

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
  const baseKey = Buffer.alloc(32).toString('base64');
  return {
    NODE_ENV: 'test',
    PORT: 3010,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'dev',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_SECONDS: 60 * 60 * 24 * 30,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    REFRESH_COOKIE_SECURE: true,
    MFA_TOTP_ENC_KEY: baseKey,
    MFA_TOTP_ENC_KEY_VERSION: 1,
    MFA_CHALLENGE_SECRET: 'b'.repeat(32),
    MFA_CHALLENGE_TTL_SECONDS: 300,
    MFA_TOTP_PERIOD_SECONDS: 30,
    MFA_TOTP_DIGITS: 6,
    MFA_TOTP_WINDOW: 1,
    MFA_TOTP_ISSUER: 'Taste & See',
    REDIS_URL: 'redis://localhost:6379',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 60,
    EMAIL_VERIFICATION_TTL_SECONDS: 86_400,
    RBAC_REVOKER_ENABLED: false,
    RBAC_REVOKER_INTERVAL_MS: 300_000,
    RBAC_REVOKER_BATCH_SIZE: 500,
    PRIVACY_OVERDUE_SWEEP_ENABLED: false,
    PRIVACY_OVERDUE_SWEEP_INTERVAL_MS: 3_600_000,
    PRIVACY_OVERDUE_SWEEP_DUE_SOON_DAYS: 7,
    PRIVACY_OVERDUE_SWEEP_MAX_LOGGED: 25,
    IMPERSONATION_SESSION_TTL_SECONDS: 3_600,
    LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW: 3,
    LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS: 60,
    VERIFICATION_RESEND_COOLDOWN_SECONDS: 60,
    VERIFICATION_TOKEN_PRUNE_ENABLED: true,
    VERIFICATION_TOKEN_PRUNE_INTERVAL_MS: 21_600_000,
    VERIFICATION_TOKEN_PRUNE_RETENTION_DAYS: 30,
    VERIFICATION_TOKEN_PRUNE_BATCH_SIZE: 5_000,
    STRIPE_SECRET_KEY: 'sk_test_xxxxxxxxxxxxxxxxxxxx',
    STRIPE_IDENTITY_RETURN_URL: 'https://app.example.com/identity/complete',
    KYC_PAYLOAD_ENC_KEY: baseKey,
    KYC_PAYLOAD_ENC_KEY_VERSION: 1,
    KYC_WEBHOOK_INTERNAL_API_KEY: 'c'.repeat(48),
    IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: 'x-internal-api-key',
    IDENTITY_PRIVACY_EXPORT_HEADER_NAME: 'x-internal-api-key',
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: 'd'.repeat(48),
    IDENTITY_PRIVACY_EXPORT_API_KEY: 'e'.repeat(48),
    OTEL_TRACES_ENABLED: true,
    OTEL_METRICS_ENABLED: true,
    ...overrides,
  };
}

function buildSvc(env: Env = buildEnv()): {
  service: IpCircuitBreakerService;
  redis: FakeRedis;
} {
  const redis = new FakeRedis();
  const service = new IpCircuitBreakerService(env, redis as unknown as Redis);
  return { service, redis };
}

const ATTACKER_IP = '203.0.113.5';
const OTHER_IP = '198.51.100.7';

describe('IpCircuitBreakerService.recordFailure', () => {
  it('returns null and is a no-op when ip is undefined', async () => {
    const { service, redis } = buildSvc();
    const got = await service.recordFailure(undefined);
    expect(got).toBeNull();
    expect(redis.counters.size).toBe(0);
  });

  it('returns null and is a no-op when ip is the empty string', async () => {
    const { service, redis } = buildSvc();
    const got = await service.recordFailure('');
    expect(got).toBeNull();
    expect(redis.counters.size).toBe(0);
  });

  it('increments the bucket on each call and returns the post-increment count', async () => {
    const { service } = buildSvc();
    expect(await service.recordFailure(ATTACKER_IP)).toBe(1);
    expect(await service.recordFailure(ATTACKER_IP)).toBe(2);
    expect(await service.recordFailure(ATTACKER_IP)).toBe(3);
  });

  it('uses separate buckets per IP', async () => {
    const { service } = buildSvc();
    expect(await service.recordFailure(ATTACKER_IP)).toBe(1);
    expect(await service.recordFailure(OTHER_IP)).toBe(1);
    expect(await service.recordFailure(ATTACKER_IP)).toBe(2);
  });

  it('returns null silently when Redis throws (fail-open posture)', async () => {
    const env = buildEnv();
    const failing = new FailingRedis();
    const svc = new IpCircuitBreakerService(env, failing as unknown as Redis);
    const got = await svc.recordFailure(ATTACKER_IP);
    expect(got).toBeNull();
  });
});

describe('IpCircuitBreakerService.checkBlocked', () => {
  it('returns false when no failures have been recorded for the IP', async () => {
    const { service } = buildSvc();
    expect(await service.checkBlocked(ATTACKER_IP)).toBe(false);
  });

  it('returns false while the count is strictly below the threshold', async () => {
    // Threshold = 3 in the test env. Two failures should not trip.
    const { service } = buildSvc();
    await service.recordFailure(ATTACKER_IP);
    await service.recordFailure(ATTACKER_IP);
    expect(await service.checkBlocked(ATTACKER_IP)).toBe(false);
  });

  it('returns true once the count reaches the threshold', async () => {
    const { service } = buildSvc();
    await service.recordFailure(ATTACKER_IP);
    await service.recordFailure(ATTACKER_IP);
    await service.recordFailure(ATTACKER_IP);
    expect(await service.checkBlocked(ATTACKER_IP)).toBe(true);
  });

  it('returns true on counts above the threshold (does not decrement)', async () => {
    const { service } = buildSvc();
    for (let i = 0; i < 5; i += 1) {
      await service.recordFailure(ATTACKER_IP);
    }
    expect(await service.checkBlocked(ATTACKER_IP)).toBe(true);
  });

  it('returns false for a different IP (per-IP isolation)', async () => {
    const { service } = buildSvc();
    for (let i = 0; i < 5; i += 1) {
      await service.recordFailure(ATTACKER_IP);
    }
    expect(await service.checkBlocked(OTHER_IP)).toBe(false);
  });

  it('returns false when ip is undefined (no-op skip)', async () => {
    const { service } = buildSvc();
    expect(await service.checkBlocked(undefined)).toBe(false);
  });

  it('returns false when ip is the empty string (no-op skip)', async () => {
    const { service } = buildSvc();
    expect(await service.checkBlocked('')).toBe(false);
  });

  it('returns false (fails open) when Redis throws', async () => {
    const env = buildEnv();
    const failing = new FailingRedis();
    const svc = new IpCircuitBreakerService(env, failing as unknown as Redis);
    expect(await svc.checkBlocked(ATTACKER_IP)).toBe(false);
  });

  it('returns false (fails open) on a non-numeric bucket value', async () => {
    const env = buildEnv();
    const redis = new FakeRedis();
    // Plant a corrupt value that resembles what a key collision with
    // a non-counter purpose could produce.
    redis.counters.set('whatever-the-key-is', 0);
    const stub = {
      async get(_key: string): Promise<string | null> {
        return 'not-a-number';
      },
      multi: redis.multi.bind(redis),
    };
    const svc = new IpCircuitBreakerService(env, stub as unknown as Redis);
    expect(await svc.checkBlocked(ATTACKER_IP)).toBe(false);
  });
});

describe('IpCircuitBreakerService — env-prefix isolation', () => {
  it('emits a different bucket key per environment', async () => {
    // Drive a `test`-mode and a `staging`-mode service against the
    // same FakeRedis. If the env prefixes collided the staging
    // service's first attempt would already be at 2.
    const sharedRedis = new FakeRedis();
    const testSvc = new IpCircuitBreakerService(buildEnv(), sharedRedis as unknown as Redis);
    const stagingSvc = new IpCircuitBreakerService(
      buildEnv({ NODE_ENV: 'staging' }),
      sharedRedis as unknown as Redis,
    );
    await testSvc.recordFailure(ATTACKER_IP);
    await testSvc.recordFailure(ATTACKER_IP);
    const stagingFirst = await stagingSvc.recordFailure(ATTACKER_IP);
    expect(stagingFirst).toBe(1);
  });

  it('redacts the IP in bucket keys (no raw IP in the Redis surface)', async () => {
    const { service, redis } = buildSvc();
    await service.recordFailure(ATTACKER_IP);
    const keys = Array.from(redis.counters.keys());
    expect(keys).toHaveLength(1);
    // The raw IP must not appear anywhere in the key — only its
    // hashed prefix.
    expect(keys[0]).not.toContain(ATTACKER_IP);
    // The key shape is `{env}:service-identity:login-ip-rate:{hash}:{window}`.
    expect(keys[0]).toMatch(/^test:service-identity:login-ip-rate:[0-9a-f]{16}:\d+$/);
  });
});

describe('IpCircuitBreakerService — threshold honours env override', () => {
  it('returns true on the first call when the threshold is set to 1', async () => {
    const env = buildEnv({ LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW: 1 });
    const { service } = buildSvc(env);
    await service.recordFailure(ATTACKER_IP);
    expect(await service.checkBlocked(ATTACKER_IP)).toBe(true);
  });

  it('returns false even at high counts when threshold is set to 100', async () => {
    const env = buildEnv({ LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW: 100 });
    const { service } = buildSvc(env);
    for (let i = 0; i < 50; i += 1) {
      await service.recordFailure(ATTACKER_IP);
    }
    expect(await service.checkBlocked(ATTACKER_IP)).toBe(false);
  });
});

/**
 * Observability metrics (TS-025-followup-1a; CLAUDE.md §10). These
 * mirror the `HttpMetricsInterceptor` test shape: init a real
 * MeterProvider, drive the service, then assert the Prometheus text
 * exposition. The service must be constructed AFTER `initMetrics` so
 * its instruments bind to the live meter rather than the no-op fallback
 * — so `buildSvc()` is called inside each test, not before init.
 *
 * The three instruments under test:
 *   - `login_ip_circuit_breaker_check_total{outcome}`
 *   - `login_ip_circuit_breaker_record_total{outcome}`
 *   - `login_ip_circuit_breaker_redis_duration_seconds{operation}` (histogram)
 *
 * The PII contract is asserted directly: the serialized scrape surface
 * never carries the raw IP (the labels are restricted to outcome /
 * operation by construction).
 */
describe('IpCircuitBreakerService — observability metrics (TS-025-followup-1a)', () => {
  beforeEach(() => {
    initMetrics({
      service: 'service-identity-test',
      env: 'test',
      // Far-future sweep so the periodic reader never races the test;
      // serializeMetrics() forces a synchronous collect on each scrape.
      exportIntervalMillis: 3_600_000,
    });
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('counts an allowed check with outcome="allowed"', async () => {
    const { service } = buildSvc();
    expect(await service.checkBlocked(ATTACKER_IP)).toBe(false);

    const out = await serializeMetrics();
    expect(out).toMatch(/login_ip_circuit_breaker_check_total\{[^}]*outcome="allowed"[^}]*\} 1/);
  });

  it('counts a tripped check with outcome="blocked"', async () => {
    const { service } = buildSvc();
    // Threshold = 3 in the test env.
    await service.recordFailure(ATTACKER_IP);
    await service.recordFailure(ATTACKER_IP);
    await service.recordFailure(ATTACKER_IP);
    expect(await service.checkBlocked(ATTACKER_IP)).toBe(true);

    const out = await serializeMetrics();
    expect(out).toMatch(/login_ip_circuit_breaker_check_total\{[^}]*outcome="blocked"[^}]*\} 1/);
    expect(out).toMatch(
      /login_ip_circuit_breaker_record_total\{[^}]*outcome="incremented"[^}]*\} 3/,
    );
  });

  it('counts a fail-open check with outcome="unavailable" when Redis throws', async () => {
    const failing = new FailingRedis();
    const service = new IpCircuitBreakerService(buildEnv(), failing as unknown as Redis);
    expect(await service.checkBlocked(ATTACKER_IP)).toBe(false);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /login_ip_circuit_breaker_check_total\{[^}]*outcome="unavailable"[^}]*\} 1/,
    );
  });

  it('counts a fail-open record with outcome="unavailable" when Redis throws', async () => {
    const failing = new FailingRedis();
    const service = new IpCircuitBreakerService(buildEnv(), failing as unknown as Redis);
    expect(await service.recordFailure(ATTACKER_IP)).toBeNull();

    const out = await serializeMetrics();
    expect(out).toMatch(
      /login_ip_circuit_breaker_record_total\{[^}]*outcome="unavailable"[^}]*\} 1/,
    );
  });

  it('records Redis latency samples bucketed by operation', async () => {
    const { service } = buildSvc();
    await service.checkBlocked(ATTACKER_IP);
    await service.recordFailure(ATTACKER_IP);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /login_ip_circuit_breaker_redis_duration_seconds_count\{[^}]*operation="check"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /login_ip_circuit_breaker_redis_duration_seconds_count\{[^}]*operation="record"[^}]*\} 1/,
    );
  });

  it('never leaks the raw IP onto the scrape surface', async () => {
    const { service } = buildSvc();
    await service.recordFailure(ATTACKER_IP);
    await service.checkBlocked(ATTACKER_IP);

    const out = await serializeMetrics();
    // The only labels are outcome / operation — the IP (raw or hashed)
    // must never appear in a metric line.
    expect(out).not.toContain(ATTACKER_IP);
    expect(out).toMatch(/login_ip_circuit_breaker_check_total/);
  });

  it('emits no breaker metric for the empty-IP skip path', async () => {
    const { service } = buildSvc();
    await service.checkBlocked(undefined);
    await service.recordFailure('');

    const out = await serializeMetrics();
    // The early-return guard runs before any instrumentation, so neither
    // counter materialises a sample for the no-IP path.
    expect(out).not.toMatch(/login_ip_circuit_breaker_check_total/);
    expect(out).not.toMatch(/login_ip_circuit_breaker_record_total/);
  });
});
