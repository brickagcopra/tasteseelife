import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * A minimal valid environment for service-content. `DATABASE_URL` is the only
 * variable required without a default; everything else has a sane default so a
 * bare-bones dev process boots. The user-JWT + idempotency-cache clusters
 * arrive with the first authenticated authoring surface (TS-281 blog admin),
 * mirroring the service-ads (TS-270 → TS-271a) shape.
 */
function validEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/content_test',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    ...overrides,
  };
}

describe('loadEnv', () => {
  it('parses a minimal valid environment and applies defaults', () => {
    const env = loadEnv(validEnv());

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3025);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.DATABASE_URL).toBe('postgresql://test:test@localhost:5432/content_test');
  });

  it('applies the TS-284 auth + idempotency cluster defaults', () => {
    const env = loadEnv(validEnv());

    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(60);
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('throws when JWT_ACCESS_SECRET is shorter than 32 chars', () => {
    expect(() => loadEnv(validEnv({ JWT_ACCESS_SECRET: 'short' }))).toThrow(EnvValidationError);
  });

  it('throws when REDIS_URL is missing or not a URL', () => {
    const { REDIS_URL: _omitted, ...withoutRedis } = validEnv();
    expect(() => loadEnv(withoutRedis)).toThrow(EnvValidationError);
    expect(() => loadEnv(validEnv({ REDIS_URL: 'localhost' }))).toThrow(EnvValidationError);
  });

  it('coerces the idempotency TTL strings to numbers', () => {
    const env = loadEnv(
      validEnv({ IDEMPOTENCY_TTL_SECONDS: '120', IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: '15' }),
    );
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(120);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(15);
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

  it('throws EnvValidationError when DATABASE_URL is missing', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
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
