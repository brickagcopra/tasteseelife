import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv, parseCorsOrigins } from './env';

/**
 * Env validation is the boot-time gate (CLAUDE.md §17.11 — never
 * hardcode environment-dependent values). The test surface is small
 * but load-bearing — every other module assumes a validated `Env`.
 *
 * TS-070 ships the skeleton-only env (Postgres + bootstrap); TS-071
 * extends it with the Socket.IO + Redis-adapter cluster and the JWT
 * verification triple. Subsequent tasks (Cassandra, idempotency cache)
 * will extend this file as each cluster lands.
 */
describe('loadEnv', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
  } as const;

  it('accepts a well-formed environment and applies defaults', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.DATABASE_URL).toBe(baseEnv.DATABASE_URL);
    expect(env.REDIS_URL).toBe(baseEnv.REDIS_URL);
    expect(env.PORT).toBe(3017);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.WS_PATH).toBe('/socket.io');
    expect(env.WS_CORS_ORIGINS).toBe('');
    expect(env.REDIS_KEY_NAMESPACE_PREFIX).toBe('dev:service-messaging:socket:');
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(60);
  });

  it('coerces the idempotency TTLs from strings', () => {
    const env = loadEnv({
      ...baseEnv,
      IDEMPOTENCY_TTL_SECONDS: '3600',
      IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: '30',
    });
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(3600);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(30);
  });

  it('throws EnvValidationError when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when DATABASE_URL is malformed', () => {
    expect(() => loadEnv({ ...baseEnv, DATABASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when REDIS_URL is missing', () => {
    const { REDIS_URL: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when REDIS_URL is malformed', () => {
    expect(() => loadEnv({ ...baseEnv, REDIS_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when JWT_ACCESS_SECRET is too short', () => {
    expect(() => loadEnv({ ...baseEnv, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('throws EnvValidationError when JWT_ACCESS_SECRET is missing', () => {
    const { JWT_ACCESS_SECRET: _omit, ...rest } = baseEnv;
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

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => loadEnv({ ...baseEnv, LOG_LEVEL: 'shouting' } as Record<string, string>)).toThrow(
      EnvValidationError,
    );
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => loadEnv({ ...baseEnv, NODE_ENV: 'qa' } as Record<string, string>)).toThrow(
      EnvValidationError,
    );
  });

  it('preserves a custom SERVICE_VERSION', () => {
    const env = loadEnv({ ...baseEnv, SERVICE_VERSION: 'v1.2.3' });
    expect(env.SERVICE_VERSION).toBe('v1.2.3');
  });

  it('preserves a custom WS_CORS_ORIGINS / WS_PATH / namespace prefix', () => {
    const env = loadEnv({
      ...baseEnv,
      WS_PATH: '/api/v1/socket.io',
      WS_CORS_ORIGINS: 'https://app.example.com, https://provider.example.com',
      REDIS_KEY_NAMESPACE_PREFIX: 'prod:service-messaging:socket:',
    });
    expect(env.WS_PATH).toBe('/api/v1/socket.io');
    expect(env.WS_CORS_ORIGINS).toBe('https://app.example.com, https://provider.example.com');
    expect(env.REDIS_KEY_NAMESPACE_PREFIX).toBe('prod:service-messaging:socket:');
  });

  it('EnvValidationError surfaces the failing path in its message', () => {
    try {
      loadEnv({} as NodeJS.ProcessEnv);
      throw new Error('loadEnv unexpectedly succeeded');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).message).toContain('DATABASE_URL');
      expect((err as EnvValidationError).issues.length).toBeGreaterThan(0);
    }
  });
});

describe('parseCorsOrigins', () => {
  it('returns an empty array on the empty-string default', () => {
    expect(parseCorsOrigins('')).toEqual([]);
  });

  it('splits on commas and trims whitespace', () => {
    expect(parseCorsOrigins('https://a.example.com, https://b.example.com')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('drops empty entries from trailing commas', () => {
    expect(parseCorsOrigins('https://a.example.com,,')).toEqual(['https://a.example.com']);
  });
});
