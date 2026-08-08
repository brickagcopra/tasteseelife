import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * Env validation is the boot-time gate (CLAUDE.md §17.11). The test surface
 * is small but load-bearing — every other module assumes a validated `Env`.
 *
 * TS-041b extends the surface with:
 *   - STRIPE_SECRET_KEY (required)
 *   - STRIPE_API_VERSION (optional pin)
 *   - JWT_ACCESS_SECRET (required, min 32)
 *   - JWT_ISSUER + JWT_AUDIENCE (defaulted)
 */
describe('loadEnv', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    STRIPE_SECRET_KEY: 'sk_test_12345_abcdef_xyz',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    REDIS_URL: 'redis://localhost:6379/0',
  } as const;

  it('accepts a well-formed environment and applies defaults', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.DATABASE_URL).toBe(baseEnv.DATABASE_URL);
    expect(env.PORT).toBe(3012);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.STRIPE_SECRET_KEY).toBe(baseEnv.STRIPE_SECRET_KEY);
    expect(env.STRIPE_API_VERSION).toBeUndefined();
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
  });

  it('throws EnvValidationError when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
  });

  it('rejects a non-URL DATABASE_URL', () => {
    expect(() => loadEnv({ ...baseEnv, DATABASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
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
    const env = loadEnv({ ...baseEnv, UNKNOWN_KEY: 'x' });
    expect((env as Record<string, unknown>).UNKNOWN_KEY).toBeUndefined();
  });

  it('exposes structured issues on the thrown error', () => {
    try {
      loadEnv({});
      throw new Error('loadEnv unexpectedly succeeded');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const issues = (err as EnvValidationError).issues;
      expect(Array.isArray(issues)).toBe(true);
      // Three required fields are each independently flagged in one failure.
      const paths = issues.flatMap((issue) => issue.path);
      expect(paths).toContain('DATABASE_URL');
      expect(paths).toContain('STRIPE_SECRET_KEY');
      expect(paths).toContain('JWT_ACCESS_SECRET');
    }
  });

  it('formats a human-readable message that names the offending field', () => {
    try {
      loadEnv({ ...baseEnv, DATABASE_URL: 'not-a-url' });
      throw new Error('loadEnv unexpectedly succeeded');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).message).toContain('DATABASE_URL');
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // STRIPE_SECRET_KEY (TS-041b)
  // ───────────────────────────────────────────────────────────────────

  it('rejects a STRIPE_SECRET_KEY shorter than the typo-guard floor', () => {
    expect(() => loadEnv({ ...baseEnv, STRIPE_SECRET_KEY: 'short' })).toThrow(EnvValidationError);
  });

  it('rejects an empty STRIPE_SECRET_KEY', () => {
    expect(() => loadEnv({ ...baseEnv, STRIPE_SECRET_KEY: '' })).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when STRIPE_SECRET_KEY is missing', () => {
    const { STRIPE_SECRET_KEY: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
  });

  // ───────────────────────────────────────────────────────────────────
  // STRIPE_API_VERSION (TS-041b)
  // ───────────────────────────────────────────────────────────────────

  it('accepts a STRIPE_API_VERSION pin', () => {
    const env = loadEnv({ ...baseEnv, STRIPE_API_VERSION: '2024-12-18.acacia' });
    expect(env.STRIPE_API_VERSION).toBe('2024-12-18.acacia');
  });

  it('rejects an empty STRIPE_API_VERSION (vs absent — absent is OK)', () => {
    expect(() => loadEnv({ ...baseEnv, STRIPE_API_VERSION: '' })).toThrow(EnvValidationError);
  });

  // ───────────────────────────────────────────────────────────────────
  // JWT_ACCESS_SECRET (TS-041b)
  // ───────────────────────────────────────────────────────────────────

  it('rejects a JWT_ACCESS_SECRET shorter than 32 chars', () => {
    expect(() => loadEnv({ ...baseEnv, JWT_ACCESS_SECRET: 'a'.repeat(31) })).toThrow(
      EnvValidationError,
    );
  });

  it('throws EnvValidationError when JWT_ACCESS_SECRET is missing', () => {
    const { JWT_ACCESS_SECRET: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
  });

  it('accepts overrides for JWT_ISSUER and JWT_AUDIENCE', () => {
    const env = loadEnv({
      ...baseEnv,
      JWT_ISSUER: 'custom-issuer',
      JWT_AUDIENCE: 'custom-audience',
    });
    expect(env.JWT_ISSUER).toBe('custom-issuer');
    expect(env.JWT_AUDIENCE).toBe('custom-audience');
  });

  // ───────────────────────────────────────────────────────────────────
  // REDIS_URL + idempotency TTLs (TS-044)
  // ───────────────────────────────────────────────────────────────────

  it('throws EnvValidationError when REDIS_URL is missing', () => {
    const { REDIS_URL: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
  });

  it('rejects a non-URL REDIS_URL', () => {
    expect(() => loadEnv({ ...baseEnv, REDIS_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('defaults IDEMPOTENCY_TTL_SECONDS to 86400 (24h)', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
  });

  it('defaults IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS to 60', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(60);
  });

  it('coerces TTL overrides from string to integer', () => {
    const env = loadEnv({
      ...baseEnv,
      IDEMPOTENCY_TTL_SECONDS: '3600',
      IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: '30',
    });
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(3600);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(30);
  });

  it('rejects a non-positive idempotency TTL', () => {
    expect(() => loadEnv({ ...baseEnv, IDEMPOTENCY_TTL_SECONDS: '0' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: '-5' })).toThrow(
      EnvValidationError,
    );
  });

  // ───────────────────────────────────────────────────────────────────
  // Observability OTel knobs (TS-042-followup-8)
  // ───────────────────────────────────────────────────────────────────

  it('defaults OTEL_TRACES_ENABLED and OTEL_METRICS_ENABLED to true', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.OTEL_TRACES_ENABLED).toBe(true);
    expect(env.OTEL_METRICS_ENABLED).toBe(true);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('coerces the string "false" to a boolean false for the OTel toggles', () => {
    const env = loadEnv({
      ...baseEnv,
      OTEL_TRACES_ENABLED: 'false',
      OTEL_METRICS_ENABLED: 'false',
    });
    expect(env.OTEL_TRACES_ENABLED).toBe(false);
    expect(env.OTEL_METRICS_ENABLED).toBe(false);
  });

  it('treats an unrecognised OTel toggle string as disabled (only "true" is truthy)', () => {
    const env = loadEnv({ ...baseEnv, OTEL_TRACES_ENABLED: 'maybe' });
    // The transform is `v.toLowerCase() === 'true'` — anything else is false.
    expect(env.OTEL_TRACES_ENABLED).toBe(false);
  });

  it('accepts a well-formed OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    const env = loadEnv({
      ...baseEnv,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318/v1/traces',
    });
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://otel-collector:4318/v1/traces');
  });

  it('rejects a non-URL OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    expect(() => loadEnv({ ...baseEnv, OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });
});
