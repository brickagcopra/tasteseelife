import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import { FakeRedis } from '../../../__tests__/fake-redis';
import { RateLimitService, formatRateLimitKey } from './rate-limit.service';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    LOG_LEVEL: 'info',
    SERVICE_VERSION: 'unit-test',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'j'.repeat(32),
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    REDIS_URL: 'redis://localhost:6379',
    RATE_LIMIT_DEFAULT_WINDOW_SECONDS: 60,
    RATE_LIMIT_DEFAULT_MAX_REQUESTS: 3,
    RATE_LIMIT_SENSITIVE_WINDOW_SECONDS: 60,
    RATE_LIMIT_SENSITIVE_MAX_REQUESTS: 2,
    DOWNSTREAM_REQUEST_TIMEOUT_MS: 5_000,
    SUBSCRIPTION_SERVICE_BASE_URL: 'http://service-subscription.local',
    HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME: 'x-household-visit-prep-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: 'x-household-memberships-internal-api-key',
    HOUSEHOLD_SCOPE_CACHE_TTL_SECONDS: 60,
    SEARCH_INDEX_HEADER_NAME: 'x-internal-api-key',
    ...overrides,
  };
}

function buildService(env: Env, redis: FakeRedis): RateLimitService {
  // The service depends on a Redis-shaped DI binding; pass the fake.
  return new RateLimitService(env, redis as unknown as never);
}

describe('formatRateLimitKey', () => {
  it('namespaces by env + service + policy + actor', () => {
    expect(
      formatRateLimitKey({ environment: 'prod', policy: 'default', actorKey: 'user:abc' }),
    ).toBe('prod:gateway:rate-limit:default:user:abc');
  });

  it('uses the policy in the key so default + sensitive are independent', () => {
    expect(
      formatRateLimitKey({ environment: 'staging', policy: 'sensitive', actorKey: 'ip:1.2.3.4' }),
    ).toBe('staging:gateway:rate-limit:sensitive:ip:1.2.3.4');
  });
});

describe('RateLimitService.consume', () => {
  const env = buildEnv();
  let redis: FakeRedis;
  let service: RateLimitService;

  beforeEach(() => {
    redis = new FakeRedis();
    service = buildService(env, redis);
  });

  it('allows the first request and reports remaining slots', async () => {
    const decision = await service.consume('default', 'user:abc');
    expect(decision.allowed).toBe(true);
    expect(decision.limit).toBe(3);
    expect(decision.remaining).toBe(2); // 3 - 1
    expect(decision.windowSeconds).toBe(60);
    expect(decision.unavailable).toBe(false);
    expect(decision.retryAfterSeconds).toBe(0);
  });

  it('blocks the limit+1 request and reports a positive Retry-After', async () => {
    const now = new Date('2026-05-16T10:00:00.000Z');
    await service.consume('default', 'user:abc', now);
    await service.consume('default', 'user:abc', new Date(now.getTime() + 10));
    await service.consume('default', 'user:abc', new Date(now.getTime() + 20));
    const blocked = await service.consume('default', 'user:abc', new Date(now.getTime() + 30));
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('passes once the window slides past the oldest request', async () => {
    const start = new Date('2026-05-16T10:00:00.000Z');
    const window = env.RATE_LIMIT_DEFAULT_WINDOW_SECONDS * 1000;

    // Three requests at t=0, t=10, t=20 fill the bucket.
    await service.consume('default', 'user:abc', new Date(start.getTime()));
    await service.consume('default', 'user:abc', new Date(start.getTime() + 10));
    await service.consume('default', 'user:abc', new Date(start.getTime() + 20));
    const blocked = await service.consume('default', 'user:abc', new Date(start.getTime() + 30));
    expect(blocked.allowed).toBe(false);

    // After the window slides past the first entry, the next request
    // succeeds.
    const after = await service.consume(
      'default',
      'user:abc',
      new Date(start.getTime() + window + 1),
    );
    expect(after.allowed).toBe(true);
  });

  it('isolates actor keys — one actor exhausting their quota does not affect another', async () => {
    const now = new Date('2026-05-16T10:00:00.000Z');
    await service.consume('default', 'user:abc', now);
    await service.consume('default', 'user:abc', new Date(now.getTime() + 1));
    await service.consume('default', 'user:abc', new Date(now.getTime() + 2));
    const aBlocked = await service.consume('default', 'user:abc', new Date(now.getTime() + 3));
    expect(aBlocked.allowed).toBe(false);

    const bFirst = await service.consume('default', 'user:other', new Date(now.getTime() + 4));
    expect(bFirst.allowed).toBe(true);
    expect(bFirst.remaining).toBe(2);
  });

  it('uses the sensitive policy ceiling when called with policy=sensitive', async () => {
    const now = new Date('2026-05-16T10:00:00.000Z');
    await service.consume('sensitive', 'ip:1.2.3.4', now);
    const second = await service.consume('sensitive', 'ip:1.2.3.4', new Date(now.getTime() + 1));
    expect(second.allowed).toBe(true);
    expect(second.limit).toBe(2);
    expect(second.remaining).toBe(0);
    const third = await service.consume('sensitive', 'ip:1.2.3.4', new Date(now.getTime() + 2));
    expect(third.allowed).toBe(false);
  });

  it('default and sensitive policies do not share buckets for the same actor', async () => {
    const now = new Date('2026-05-16T10:00:00.000Z');
    await service.consume('sensitive', 'user:abc', now);
    await service.consume('sensitive', 'user:abc', new Date(now.getTime() + 1));
    const sensitiveBlocked = await service.consume(
      'sensitive',
      'user:abc',
      new Date(now.getTime() + 2),
    );
    expect(sensitiveBlocked.allowed).toBe(false);

    const defaultAllowed = await service.consume('default', 'user:abc', now);
    expect(defaultAllowed.allowed).toBe(true);
  });

  it('fails open when Redis throws (CLAUDE.md §4.3)', async () => {
    redis.failOn = 'eval';
    const decision = await service.consume('default', 'user:abc');
    expect(decision.allowed).toBe(true);
    expect(decision.unavailable).toBe(true);
    expect(decision.remaining).toBe(env.RATE_LIMIT_DEFAULT_MAX_REQUESTS);
    expect(decision.retryAfterSeconds).toBe(0);
  });

  it('fails open when Redis returns a malformed payload', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const badRedis = {
      eval: async (): Promise<unknown> => 'definitely-not-an-array',
    };
    const localService = buildService(env, badRedis as unknown as FakeRedis);
    const decision = await localService.consume('default', 'user:abc');
    expect(decision.allowed).toBe(true);
    expect(decision.unavailable).toBe(true);
    warnSpy.mockRestore();
  });

  it('records keys under the correct env + policy + actor namespace', async () => {
    await service.consume('default', 'user:abc');
    const key = formatRateLimitKey({
      environment: env.NODE_ENV,
      policy: 'default',
      actorKey: 'user:abc',
    });
    expect(redis.__peek(key)).not.toBeNull();
    expect(redis.__peek(key)!.length).toBe(1);
  });
});
