import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * A minimal valid environment for service-trust-safety. `DATABASE_URL`,
 * `JWT_ACCESS_SECRET`, and `REDIS_URL` are required without defaults (the
 * latter two arrived with the first authenticated surface, TS-301a incident
 * intake — mirroring the service-concierge TS-221 → TS-222 shape); everything
 * else has a sane default so a bare-bones dev process boots.
 */
function validEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/trust_safety_test',
    JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret!',
    INTERNAL_TRUST_SIGNING_SECRET: 'test-secret-test-secret-test-secret!',
    REDIS_URL: 'redis://localhost:6379/0',
    ...overrides,
  };
}

describe('loadEnv', () => {
  it('parses a minimal valid environment and applies defaults', () => {
    const env = loadEnv(validEnv());

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3026);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.DATABASE_URL).toBe('postgresql://test:test@localhost:5432/trust_safety_test');
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(60);
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
    const { DATABASE_URL: _omitted, ...rest } = validEnv();
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when DATABASE_URL is not a URL', () => {
    expect(() => loadEnv(validEnv({ DATABASE_URL: 'not-a-url' }))).toThrow(EnvValidationError);
  });

  it('requires JWT_ACCESS_SECRET of HMAC block length (TS-301a)', () => {
    const { JWT_ACCESS_SECRET: _omitted, ...rest } = validEnv();
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
    expect(() => loadEnv(validEnv({ JWT_ACCESS_SECRET: 'too-short' }))).toThrow(EnvValidationError);
  });

  it('requires a valid REDIS_URL (TS-301a idempotency cache)', () => {
    const { REDIS_URL: _omitted, ...rest } = validEnv();
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
    expect(() => loadEnv(validEnv({ REDIS_URL: 'not-a-url' }))).toThrow(EnvValidationError);
  });

  it('rejects an invalid NODE_ENV instead of falling back', () => {
    expect(() => loadEnv(validEnv({ NODE_ENV: 'prod' }))).toThrow(EnvValidationError);
  });

  it('ignores ambient / Kubernetes-injected env keys (TS-153 strict-on-ours-only)', () => {
    const env = loadEnv(
      validEnv({
        PATH: '/usr/bin',
        HOSTNAME: 'pod-abc123',
        TRUST_SAFETY_SERVICE_PORT: 'tcp://10.0.0.1:3026',
      }),
    );

    expect(env.PORT).toBe(3026);
  });
});
