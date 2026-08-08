import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * Env validation is the boot-time gate (CLAUDE.md §17.11 — never
 * hardcode environment-dependent values). The test surface is small
 * but load-bearing — every other module assumes a validated `Env`.
 *
 * TS-060 shipped the skeleton — `DATABASE_URL` only. TS-060-followup-1
 * adds three required clusters (JWT verification, Redis idempotency
 * cache, outbox producer) — covered below.
 */
describe('loadEnv', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    BOOKING_TIER_DISPATCH_API_KEY: 'b'.repeat(40),
    BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY: 'c'.repeat(40),
  } as const;

  it('accepts a well-formed environment and applies defaults', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.DATABASE_URL).toBe(baseEnv.DATABASE_URL);
    expect(env.PORT).toBe(3027);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(60);
    expect(env.OUTBOX_PRODUCER_SERVICE).toBe('service-booking');
    expect(env.BOOKING_TIER_GATING_MODE).toBe('advisory');
    expect(env.BOOKING_TIER_DISPATCH_HEADER_NAME).toBe('x-internal-api-key');
    expect(env.BOOKING_TIER_DISPATCH_API_KEY).toBe(baseEnv.BOOKING_TIER_DISPATCH_API_KEY);
    // TS-235 — wellness-summary internal header defaults like the
    // tier-dispatch header; the key has no default (required).
    expect(env.BOOKING_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME).toBe('x-internal-api-key');
    expect(env.BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY).toBe(
      baseEnv.BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY,
    );
    // TS-205 — accept-window default is 30 minutes.
    expect(env.BOOKING_ACCEPT_WINDOW_MINUTES).toBe(30);
    // TS-060-followup-4 — observability flags default enabled; the OTLP
    // endpoint is optional (falls back to the standard OTEL_* conventions).
    expect(env.OTEL_TRACES_ENABLED).toBe(true);
    expect(env.OTEL_METRICS_ENABLED).toBe(true);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('coerces string OTEL flags and validates the OTLP endpoint URL', () => {
    const env = loadEnv({
      ...baseEnv,
      OTEL_TRACES_ENABLED: 'false',
      OTEL_METRICS_ENABLED: 'false',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/v1/traces',
    });
    expect(env.OTEL_TRACES_ENABLED).toBe(false);
    expect(env.OTEL_METRICS_ENABLED).toBe(false);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://collector:4318/v1/traces');
  });

  it('rejects a malformed OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    expect(() => loadEnv({ ...baseEnv, OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });

  it('coerces a numeric BOOKING_ACCEPT_WINDOW_MINUTES override', () => {
    const env = loadEnv({ ...baseEnv, BOOKING_ACCEPT_WINDOW_MINUTES: '60' });
    expect(env.BOOKING_ACCEPT_WINDOW_MINUTES).toBe(60);
  });

  it('rejects BOOKING_ACCEPT_WINDOW_MINUTES below the contract minimum', () => {
    expect(() => loadEnv({ ...baseEnv, BOOKING_ACCEPT_WINDOW_MINUTES: '0' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects BOOKING_ACCEPT_WINDOW_MINUTES above the contract maximum', () => {
    expect(() => loadEnv({ ...baseEnv, BOOKING_ACCEPT_WINDOW_MINUTES: '1500' })).toThrow(
      EnvValidationError,
    );
  });

  it('throws EnvValidationError when BOOKING_TIER_DISPATCH_API_KEY is missing', () => {
    const { BOOKING_TIER_DISPATCH_API_KEY, ...rest } = baseEnv;
    void BOOKING_TIER_DISPATCH_API_KEY;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when BOOKING_TIER_DISPATCH_API_KEY is too short', () => {
    expect(() => loadEnv({ ...baseEnv, BOOKING_TIER_DISPATCH_API_KEY: 'short' })).toThrow(
      EnvValidationError,
    );
  });

  it('throws EnvValidationError when BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY is missing', () => {
    const { BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY, ...rest } = baseEnv;
    void BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY is too short', () => {
    expect(() =>
      loadEnv({ ...baseEnv, BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY: 'short' }),
    ).toThrow(EnvValidationError);
  });

  it('honours a custom BOOKING_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME override', () => {
    const env = loadEnv({
      ...baseEnv,
      BOOKING_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME: 'x-wellness-summary-key',
    });
    expect(env.BOOKING_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME).toBe('x-wellness-summary-key');
  });

  it('rejects an unknown BOOKING_TIER_GATING_MODE value', () => {
    expect(() => loadEnv({ ...baseEnv, BOOKING_TIER_GATING_MODE: 'off' })).toThrow(
      EnvValidationError,
    );
  });

  it('throws EnvValidationError when DATABASE_URL is missing', () => {
    const { DATABASE_URL, ...rest } = baseEnv;
    void DATABASE_URL;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when JWT_ACCESS_SECRET is missing', () => {
    const { JWT_ACCESS_SECRET, ...rest } = baseEnv;
    void JWT_ACCESS_SECRET;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when JWT_ACCESS_SECRET is too short', () => {
    expect(() => loadEnv({ ...baseEnv, JWT_ACCESS_SECRET: 'tooshort' })).toThrow(
      EnvValidationError,
    );
  });

  it('throws EnvValidationError when REDIS_URL is missing', () => {
    const { REDIS_URL, ...rest } = baseEnv;
    void REDIS_URL;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('rejects a non-URL DATABASE_URL', () => {
    expect(() => loadEnv({ ...baseEnv, DATABASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('rejects a non-URL REDIS_URL', () => {
    expect(() => loadEnv({ ...baseEnv, REDIS_URL: 'not-a-url' })).toThrow(EnvValidationError);
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

  it('coerces idempotency TTLs from string to number', () => {
    const env = loadEnv({
      ...baseEnv,
      IDEMPOTENCY_TTL_SECONDS: '3600',
      IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: '30',
    });
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(3600);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(30);
  });

  it('rejects non-positive idempotency TTLs', () => {
    expect(() => loadEnv({ ...baseEnv, IDEMPOTENCY_TTL_SECONDS: '0' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: '-1' })).toThrow(
      EnvValidationError,
    );
  });

  it('honours custom NODE_ENV / LOG_LEVEL / SERVICE_VERSION / OUTBOX_PRODUCER_SERVICE overrides', () => {
    const env = loadEnv({
      ...baseEnv,
      NODE_ENV: 'staging',
      LOG_LEVEL: 'debug',
      SERVICE_VERSION: 'v1.2.3',
      OUTBOX_PRODUCER_SERVICE: 'service-booking-canary',
    });
    expect(env.NODE_ENV).toBe('staging');
    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.SERVICE_VERSION).toBe('v1.2.3');
    expect(env.OUTBOX_PRODUCER_SERVICE).toBe('service-booking-canary');
  });

  it('honours custom JWT_ISSUER / JWT_AUDIENCE overrides', () => {
    const env = loadEnv({
      ...baseEnv,
      JWT_ISSUER: 'iss-custom',
      JWT_AUDIENCE: 'aud-custom',
    });
    expect(env.JWT_ISSUER).toBe('iss-custom');
    expect(env.JWT_AUDIENCE).toBe('aud-custom');
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => loadEnv({ ...baseEnv, LOG_LEVEL: 'noisy' })).toThrow(EnvValidationError);
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
      expect(issues.some((issue) => issue.path.includes('DATABASE_URL'))).toBe(true);
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
});
