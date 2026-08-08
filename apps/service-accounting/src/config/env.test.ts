import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * Env validation is the boot-time gate (CLAUDE.md §17.11). The test
 * surface is small but load-bearing — every other module assumes a
 * validated `Env`.
 */
describe('loadEnv', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    INTERNAL_POST_JOURNAL_API_KEY: 'b'.repeat(32),
  } as const;

  it('accepts a well-formed environment and applies defaults', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.DATABASE_URL).toBe(baseEnv.DATABASE_URL);
    expect(env.PORT).toBe(3015);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(60 * 60 * 24);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(30);
  });

  it('throws EnvValidationError when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
  });

  it('rejects a non-URL DATABASE_URL', () => {
    expect(() => loadEnv({ ...baseEnv, DATABASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('throws when JWT_ACCESS_SECRET is missing', () => {
    const { JWT_ACCESS_SECRET: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
  });

  it('rejects a JWT_ACCESS_SECRET shorter than 32 chars', () => {
    expect(() => loadEnv({ ...baseEnv, JWT_ACCESS_SECRET: 'a'.repeat(31) })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => loadEnv({ ...baseEnv, NODE_ENV: 'qa' })).toThrow(EnvValidationError);
  });

  it('rejects a non-positive PORT', () => {
    expect(() => loadEnv({ ...baseEnv, PORT: '0' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, PORT: '-1' })).toThrow(EnvValidationError);
  });

  it('coerces PORT from string to number', () => {
    const env = loadEnv({ ...baseEnv, PORT: '4000' });
    expect(env.PORT).toBe(4000);
  });

  it('ignores undeclared env keys (tolerates ambient / k8s-injected vars)', () => {
    // TS-153: a pod's process.env carries PATH/HOME + Kubernetes-injected
    // POD_* and <SERVICE>_SERVICE_HOST/_PORT vars; loadEnv strips undeclared
    // keys rather than CrashLoop on them at boot.
    const env = loadEnv({ ...baseEnv, NEW_FANCY_VAR: 'oops' } as NodeJS.ProcessEnv);
    expect((env as Record<string, unknown>).NEW_FANCY_VAR).toBeUndefined();
  });

  it('honours a non-default JWT_ISSUER + JWT_AUDIENCE', () => {
    const env = loadEnv({
      ...baseEnv,
      JWT_ISSUER: 'taste-and-see/gateway',
      JWT_AUDIENCE: 'taste-and-see/admin',
    });
    expect(env.JWT_ISSUER).toBe('taste-and-see/gateway');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/admin');
  });

  it('produces a formatted EnvValidationError with each failing path', () => {
    try {
      loadEnv({} as NodeJS.ProcessEnv);
      expect.fail('expected loadEnv to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const e = err as EnvValidationError;
      const paths = e.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('DATABASE_URL');
      expect(paths).toContain('JWT_ACCESS_SECRET');
      expect(paths).toContain('REDIS_URL');
      expect(paths).toContain('INTERNAL_POST_JOURNAL_API_KEY');
    }
  });

  it('rejects a malformed REDIS_URL', () => {
    expect(() => loadEnv({ ...baseEnv, REDIS_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('rejects an INTERNAL_POST_JOURNAL_API_KEY shorter than 32 chars', () => {
    expect(() => loadEnv({ ...baseEnv, INTERNAL_POST_JOURNAL_API_KEY: 'b'.repeat(31) })).toThrow(
      EnvValidationError,
    );
  });

  it('coerces IDEMPOTENCY_* env vars from string to number', () => {
    const env = loadEnv({
      ...baseEnv,
      IDEMPOTENCY_TTL_SECONDS: '120',
      IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: '15',
    });
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(120);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(15);
  });

  it('defaults the outbox consumer knobs', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.OUTBOX_CONSUMER_NAME).toBe('default');
    expect(env.OUTBOX_STREAM_PREFIX).toBe('events');
    expect(env.OUTBOX_CONSUMER_MAX_ATTEMPTS).toBe(10);
    expect(env.OUTBOX_CONSUMER_POLL_BLOCK_MS).toBe(5000);
    expect(env.OUTBOX_CONSUMER_RECLAIM_IDLE_MS).toBe(60_000);
    expect(env.OUTBOX_CONSUMER_POLL_INTERVAL_MS).toBe(1000);
  });

  it('honours overridden outbox consumer knobs', () => {
    const env = loadEnv({
      ...baseEnv,
      OUTBOX_CONSUMER_NAME: 'service-accounting-pod-7',
      OUTBOX_STREAM_PREFIX: 'taste-events',
      OUTBOX_CONSUMER_MAX_ATTEMPTS: '25',
      OUTBOX_CONSUMER_POLL_BLOCK_MS: '2500',
      OUTBOX_CONSUMER_RECLAIM_IDLE_MS: '30000',
      OUTBOX_CONSUMER_POLL_INTERVAL_MS: '500',
    });
    expect(env.OUTBOX_CONSUMER_NAME).toBe('service-accounting-pod-7');
    expect(env.OUTBOX_STREAM_PREFIX).toBe('taste-events');
    expect(env.OUTBOX_CONSUMER_MAX_ATTEMPTS).toBe(25);
    expect(env.OUTBOX_CONSUMER_POLL_BLOCK_MS).toBe(2500);
    expect(env.OUTBOX_CONSUMER_RECLAIM_IDLE_MS).toBe(30_000);
    expect(env.OUTBOX_CONSUMER_POLL_INTERVAL_MS).toBe(500);
  });

  it('rejects non-positive OUTBOX_CONSUMER_MAX_ATTEMPTS', () => {
    expect(() => loadEnv({ ...baseEnv, OUTBOX_CONSUMER_MAX_ATTEMPTS: '0' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects negative OUTBOX_CONSUMER_POLL_BLOCK_MS', () => {
    expect(() => loadEnv({ ...baseEnv, OUTBOX_CONSUMER_POLL_BLOCK_MS: '-1' })).toThrow(
      EnvValidationError,
    );
  });
});
