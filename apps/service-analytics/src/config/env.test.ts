import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * A minimal valid environment for service-analytics. `DATABASE_URL` and
 * `JWT_ACCESS_SECRET` are required without a default; everything else has a
 * sane default so a bare-bones dev process boots.
 */
function validEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/analytics_test',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    INTERNAL_AGGREGATION_API_KEY: 'a'.repeat(32),
    ...overrides,
  };
}

describe('loadEnv', () => {
  it('parses a minimal valid environment and applies defaults', () => {
    const env = loadEnv(validEnv());

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3023);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.DATABASE_URL).toBe('postgresql://test:test@localhost:5432/analytics_test');
  });

  it('applies the access-token verification defaults', () => {
    const env = loadEnv(validEnv());

    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
  });

  it('honours explicit JWT issuer / audience overrides', () => {
    const env = loadEnv(
      validEnv({ JWT_ISSUER: 'taste-and-see/custom', JWT_AUDIENCE: 'taste-and-see/internal' }),
    );

    expect(env.JWT_ISSUER).toBe('taste-and-see/custom');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/internal');
  });

  it('throws EnvValidationError when JWT_ACCESS_SECRET is shorter than 32 chars', () => {
    expect(() => loadEnv(validEnv({ JWT_ACCESS_SECRET: 'short' }))).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when JWT_ACCESS_SECRET is missing', () => {
    expect(() =>
      loadEnv({ DATABASE_URL: 'postgresql://test:test@localhost:5432/analytics_test' }),
    ).toThrow(EnvValidationError);
  });

  it('coerces a string PORT to a number', () => {
    const env = loadEnv(validEnv({ PORT: '4321' }));

    expect(env.PORT).toBe(4321);
  });

  it('honours explicit NODE_ENV / LOG_LEVEL / SERVICE_VERSION overrides', () => {
    const env = loadEnv(
      validEnv({ NODE_ENV: 'production', LOG_LEVEL: 'warn', SERVICE_VERSION: 'v1.2.3' }),
    );

    expect(env.NODE_ENV).toBe('production');
    expect(env.LOG_LEVEL).toBe('warn');
    expect(env.SERVICE_VERSION).toBe('v1.2.3');
  });

  it('applies the outbox-consumer defaults (TS-217-prep-3a)', () => {
    const env = loadEnv(validEnv());

    expect(env.OUTBOX_CONSUMER_NAME).toBe('default');
    expect(env.OUTBOX_STREAM_PREFIX).toBe('events');
    expect(env.OUTBOX_CONSUMER_MAX_ATTEMPTS).toBe(10);
    expect(env.OUTBOX_CONSUMER_POLL_BLOCK_MS).toBe(5000);
    expect(env.OUTBOX_CONSUMER_RECLAIM_IDLE_MS).toBe(60_000);
    expect(env.OUTBOX_CONSUMER_POLL_INTERVAL_MS).toBe(1000);
  });

  it('coerces + honours explicit outbox-consumer overrides', () => {
    const env = loadEnv(
      validEnv({
        OUTBOX_CONSUMER_NAME: 'analytics-pod-7',
        OUTBOX_STREAM_PREFIX: 'evt',
        OUTBOX_CONSUMER_MAX_ATTEMPTS: '5',
        OUTBOX_CONSUMER_POLL_BLOCK_MS: '2000',
        OUTBOX_CONSUMER_RECLAIM_IDLE_MS: '30000',
        OUTBOX_CONSUMER_POLL_INTERVAL_MS: '500',
      }),
    );

    expect(env.OUTBOX_CONSUMER_NAME).toBe('analytics-pod-7');
    expect(env.OUTBOX_STREAM_PREFIX).toBe('evt');
    expect(env.OUTBOX_CONSUMER_MAX_ATTEMPTS).toBe(5);
    expect(env.OUTBOX_CONSUMER_POLL_BLOCK_MS).toBe(2000);
    expect(env.OUTBOX_CONSUMER_RECLAIM_IDLE_MS).toBe(30_000);
    expect(env.OUTBOX_CONSUMER_POLL_INTERVAL_MS).toBe(500);
  });

  it('throws EnvValidationError when INTERNAL_AGGREGATION_API_KEY is missing', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://test:test@localhost:5432/analytics_test',
        JWT_ACCESS_SECRET: 'x'.repeat(32),
        INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when INTERNAL_AGGREGATION_API_KEY is shorter than 32 chars', () => {
    expect(() => loadEnv(validEnv({ INTERNAL_AGGREGATION_API_KEY: 'short' }))).toThrow(
      EnvValidationError,
    );
  });

  it('throws EnvValidationError when REDIS_URL is missing', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://test:test@localhost:5432/analytics_test',
        JWT_ACCESS_SECRET: 'x'.repeat(32),
        INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
      }),
    ).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when REDIS_URL is not a URL', () => {
    expect(() => loadEnv(validEnv({ REDIS_URL: 'not-a-url' }))).toThrow(EnvValidationError);
  });

  it('rejects a non-positive OUTBOX_CONSUMER_MAX_ATTEMPTS', () => {
    expect(() => loadEnv(validEnv({ OUTBOX_CONSUMER_MAX_ATTEMPTS: '0' }))).toThrow(
      EnvValidationError,
    );
  });

  it('throws EnvValidationError when DATABASE_URL is missing', () => {
    expect(() =>
      loadEnv({ JWT_ACCESS_SECRET: 'x'.repeat(32), REDIS_URL: 'redis://localhost:6379' }),
    ).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when DATABASE_URL is not a URL', () => {
    expect(() => loadEnv(validEnv({ DATABASE_URL: 'not-a-url' }))).toThrow(EnvValidationError);
  });

  it('rejects an out-of-range NODE_ENV value', () => {
    expect(() => loadEnv(validEnv({ NODE_ENV: 'staging-2' }))).toThrow(EnvValidationError);
  });

  it('rejects a non-positive PORT', () => {
    expect(() => loadEnv(validEnv({ PORT: '0' }))).toThrow(EnvValidationError);
  });

  it('ignores undeclared env keys (tolerates ambient / k8s-injected vars)', () => {
    // TS-153: a pod's process.env carries PATH/HOME + Kubernetes-injected
    // POD_* and <SERVICE>_SERVICE_HOST/_PORT vars; loadEnv strips undeclared
    // keys rather than CrashLoop on them at boot.
    const env = loadEnv(validEnv({ UNEXPECTED_KEY: 'x' }));
    expect((env as Record<string, unknown>).UNEXPECTED_KEY).toBeUndefined();
  });

  it('EnvValidationError carries the failing issue paths in its message', () => {
    try {
      loadEnv({});
      throw new Error('loadEnv unexpectedly resolved');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).message).toContain('DATABASE_URL');
      expect((err as EnvValidationError).issues.length).toBeGreaterThan(0);
    }
  });
});
