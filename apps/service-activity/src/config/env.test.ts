import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * Env validation is the boot-time gate (CLAUDE.md §17.11 — never
 * hardcode environment-dependent values). The test surface is small
 * but load-bearing — every other module assumes a validated `Env`.
 *
 * TS-101 ships skeleton + JWT verification + internal-ingest shared
 * secret + Redis (for the optional Idempotency cache). Each cluster is
 * exercised below.
 */
describe('loadEnv', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    ACTIVITY_INGEST_API_KEY: 'k'.repeat(40),
    REDIS_URL: 'redis://localhost:6379',
  } as const;

  it('accepts a well-formed environment and applies defaults', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.DATABASE_URL).toBe(baseEnv.DATABASE_URL);
    expect(env.PORT).toBe(3018);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.ACTIVITY_INGEST_HEADER_NAME).toBe('x-internal-api-key');
    expect(env.ACTIVITY_INGEST_API_KEY).toBe(baseEnv.ACTIVITY_INGEST_API_KEY);
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(60);
  });

  it('throws EnvValidationError when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when DATABASE_URL is malformed', () => {
    expect(() => loadEnv({ ...baseEnv, DATABASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when JWT_ACCESS_SECRET is too short', () => {
    expect(() => loadEnv({ ...baseEnv, JWT_ACCESS_SECRET: 'short' })).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when ACTIVITY_INGEST_API_KEY is missing', () => {
    const { ACTIVITY_INGEST_API_KEY: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when ACTIVITY_INGEST_API_KEY is too short', () => {
    expect(() => loadEnv({ ...baseEnv, ACTIVITY_INGEST_API_KEY: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('throws EnvValidationError when REDIS_URL is missing', () => {
    const { REDIS_URL: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('coerces PORT from a string', () => {
    const env = loadEnv({ ...baseEnv, PORT: '4444' });
    expect(env.PORT).toBe(4444);
  });

  it('ignores undeclared env keys (tolerates ambient / k8s-injected vars)', () => {
    // TS-153: a pod's process.env carries PATH/HOME + Kubernetes-injected
    // POD_* and <SERVICE>_SERVICE_HOST/_PORT vars; loadEnv strips undeclared
    // keys rather than CrashLoop on them at boot.
    const env = loadEnv({ ...baseEnv, NOT_A_REAL_VAR: 'oops' } as Record<string, string>);
    expect((env as Record<string, unknown>).NOT_A_REAL_VAR).toBeUndefined();
  });

  it('accepts a custom ACTIVITY_INGEST_HEADER_NAME override', () => {
    const env = loadEnv({ ...baseEnv, ACTIVITY_INGEST_HEADER_NAME: 'x-tns-ingest' });
    expect(env.ACTIVITY_INGEST_HEADER_NAME).toBe('x-tns-ingest');
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => loadEnv({ ...baseEnv, LOG_LEVEL: 'chatty' })).toThrow(EnvValidationError);
  });
});
