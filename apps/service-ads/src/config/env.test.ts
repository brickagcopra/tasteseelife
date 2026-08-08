import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * A minimal valid environment for service-ads. `DATABASE_URL`,
 * `ADS_INTERNAL_API_KEY` (TS-218a), and — since TS-271a — `JWT_ACCESS_SECRET`
 * + `REDIS_URL` are required without a default; everything else has a sane
 * default so a bare-bones dev process boots. The user-JWT + idempotency-cache
 * clusters arrived with the first authenticated surface (TS-271a campaign
 * admin), mirroring the service-academy (TS-251) shape.
 */
function validEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/ads_test',
    ADS_INTERNAL_API_KEY: 'a'.repeat(32),
    JWT_ACCESS_SECRET: 'b'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    ...overrides,
  };
}

describe('loadEnv', () => {
  it('parses a minimal valid environment and applies defaults', () => {
    const env = loadEnv(validEnv());

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3024);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.DATABASE_URL).toBe('postgresql://test:test@localhost:5432/ads_test');
    expect(env.ADS_INTERNAL_HEADER_NAME).toBe('x-internal-api-key');
    // TS-271a JWT + idempotency cluster defaults.
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(60);
    // TS-270-followup-1 observability cluster defaults.
    expect(env.OTEL_TRACES_ENABLED).toBe(true);
    expect(env.OTEL_METRICS_ENABLED).toBe(true);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('throws EnvValidationError when JWT_ACCESS_SECRET is missing (TS-271a)', () => {
    const { JWT_ACCESS_SECRET: _omit, ...rest } = validEnv();
    void _omit;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when JWT_ACCESS_SECRET is too short (TS-271a)', () => {
    expect(() => loadEnv(validEnv({ JWT_ACCESS_SECRET: 'short' }))).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when REDIS_URL is missing (TS-271a)', () => {
    const { REDIS_URL: _omit, ...rest } = validEnv();
    void _omit;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when REDIS_URL is not a URL (TS-271a)', () => {
    expect(() => loadEnv(validEnv({ REDIS_URL: 'not-a-url' }))).toThrow(EnvValidationError);
  });

  it('coerces idempotency TTL overrides to numbers (TS-271a)', () => {
    const env = loadEnv(
      validEnv({ IDEMPOTENCY_TTL_SECONDS: '3600', IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: '30' }),
    );
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(3600);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(30);
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

  it('throws EnvValidationError when ADS_INTERNAL_API_KEY is missing', () => {
    expect(() => loadEnv({ DATABASE_URL: 'postgresql://t:t@localhost:5432/ads' })).toThrow(
      EnvValidationError,
    );
  });

  it('throws EnvValidationError when ADS_INTERNAL_API_KEY is too short', () => {
    expect(() => loadEnv(validEnv({ ADS_INTERNAL_API_KEY: 'short' }))).toThrow(EnvValidationError);
  });

  it('honours an explicit ADS_INTERNAL_HEADER_NAME override', () => {
    const env = loadEnv(validEnv({ ADS_INTERNAL_HEADER_NAME: 'x-ads-key' }));
    expect(env.ADS_INTERNAL_HEADER_NAME).toBe('x-ads-key');
  });

  // ── Observability cluster (TS-270-followup-1) ──────────────────────────
  it('coerces OTEL_TRACES_ENABLED / OTEL_METRICS_ENABLED string flags to booleans', () => {
    const env = loadEnv(validEnv({ OTEL_TRACES_ENABLED: 'false', OTEL_METRICS_ENABLED: 'false' }));
    expect(env.OTEL_TRACES_ENABLED).toBe(false);
    expect(env.OTEL_METRICS_ENABLED).toBe(false);
  });

  it('treats a non-"true" OTEL_TRACES_ENABLED string as false', () => {
    const env = loadEnv(validEnv({ OTEL_TRACES_ENABLED: 'maybe' }));
    expect(env.OTEL_TRACES_ENABLED).toBe(false);
  });

  it('accepts a well-formed OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    const env = loadEnv(
      validEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318/v1/traces' }),
    );
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://otel-collector:4318/v1/traces');
  });

  it('rejects a non-URL OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    expect(() => loadEnv(validEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url' }))).toThrow(
      EnvValidationError,
    );
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
