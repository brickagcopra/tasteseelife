import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * Env validation is the boot-time gate (CLAUDE.md §17.11 — never
 * hardcode environment-dependent values). The test surface is small
 * but load-bearing — every other module assumes a validated `Env`.
 *
 * TS-050 shipped the minimal skeleton — only `DATABASE_URL` was
 * required. TS-051 extended the env contract with five clusters:
 *   1. JWT verification (JWT_ACCESS_SECRET / JWT_ISSUER / JWT_AUDIENCE).
 *   2. Redis idempotency (REDIS_URL + two TTL knobs).
 *   3. Background-check payload encryption
 *      (BACKGROUND_CHECK_PAYLOAD_ENC_KEY + key version).
 *   4. Checkr REST API (CHECKR_API_KEY / CHECKR_API_BASE_URL /
 *      CHECKR_DEFAULT_PACKAGE / CHECKR_DEFAULT_WORK_LOCATION_STATES /
 *      CHECKR_REQUEST_TIMEOUT_MS).
 *   5. Internal cross-service dispatch
 *      (BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY).
 *
 * Every test below carries the full minimal-required-fields `baseEnv`
 * so a single missing key surfaces as a clear validation failure
 * rather than as a cascade of unrelated errors.
 */
describe('loadEnv', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    BACKGROUND_CHECK_PAYLOAD_ENC_KEY: Buffer.alloc(32, 0).toString('base64'),
    CHECKR_API_KEY: 'k'.repeat(32),
    BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY: 'w'.repeat(48),
    PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY: 'b'.repeat(48),
    PROVIDER_DISCOVERY_INTERNAL_API_KEY: 'd'.repeat(48),
  } as const;

  it('accepts a well-formed environment and applies defaults', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.DATABASE_URL).toBe(baseEnv.DATABASE_URL);
    expect(env.PORT).toBe(3014);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(60);
    expect(env.BACKGROUND_CHECK_PAYLOAD_ENC_KEY_VERSION).toBe(1);
    expect(env.CHECKR_API_BASE_URL).toBe('https://api.checkr.com/v1');
    expect(env.CHECKR_DEFAULT_PACKAGE).toBe('tasker_standard');
    expect(env.CHECKR_DEFAULT_WORK_LOCATION_STATES).toBe('NY');
    expect(env.CHECKR_REQUEST_TIMEOUT_MS).toBe(10_000);
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

  it('honours custom NODE_ENV / LOG_LEVEL / SERVICE_VERSION overrides', () => {
    const env = loadEnv({
      ...baseEnv,
      NODE_ENV: 'staging',
      LOG_LEVEL: 'debug',
      SERVICE_VERSION: 'v1.2.3',
    });
    expect(env.NODE_ENV).toBe('staging');
    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.SERVICE_VERSION).toBe('v1.2.3');
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

  it('rejects a JWT_ACCESS_SECRET shorter than 32 chars', () => {
    expect(() => loadEnv({ ...baseEnv, JWT_ACCESS_SECRET: 'tooshort' })).toThrow(
      EnvValidationError,
    );
  });

  it('honours custom JWT_ISSUER / JWT_AUDIENCE overrides', () => {
    const env = loadEnv({
      ...baseEnv,
      JWT_ISSUER: 'taste-and-see/test-issuer',
      JWT_AUDIENCE: 'taste-and-see/test-aud',
    });
    expect(env.JWT_ISSUER).toBe('taste-and-see/test-issuer');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/test-aud');
  });

  it('rejects a non-URL REDIS_URL', () => {
    // `localhost:6379` parses as a URL with scheme `localhost`; use a
    // clearly invalid string that the URL constructor rejects.
    expect(() => loadEnv({ ...baseEnv, REDIS_URL: 'not a url' })).toThrow(EnvValidationError);
  });

  it('coerces IDEMPOTENCY_TTL_SECONDS and IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS from string', () => {
    const env = loadEnv({
      ...baseEnv,
      IDEMPOTENCY_TTL_SECONDS: '600',
      IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: '30',
    });
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(600);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(30);
  });

  it('rejects non-positive idempotency TTLs', () => {
    expect(() => loadEnv({ ...baseEnv, IDEMPOTENCY_TTL_SECONDS: '0' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: '-1' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a BACKGROUND_CHECK_PAYLOAD_ENC_KEY that does not decode to 32 bytes', () => {
    // 16-byte key base64-encoded — wrong length.
    expect(() =>
      loadEnv({
        ...baseEnv,
        BACKGROUND_CHECK_PAYLOAD_ENC_KEY: Buffer.alloc(16, 0).toString('base64'),
      }),
    ).toThrow(EnvValidationError);
  });

  it('rejects a CHECKR_API_KEY shorter than 20 chars', () => {
    expect(() => loadEnv({ ...baseEnv, CHECKR_API_KEY: 'short' })).toThrow(EnvValidationError);
  });

  it('rejects a non-URL CHECKR_API_BASE_URL', () => {
    expect(() => loadEnv({ ...baseEnv, CHECKR_API_BASE_URL: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });

  it('bounds CHECKR_REQUEST_TIMEOUT_MS to [500, 30000]', () => {
    expect(() => loadEnv({ ...baseEnv, CHECKR_REQUEST_TIMEOUT_MS: '100' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...baseEnv, CHECKR_REQUEST_TIMEOUT_MS: '60000' })).toThrow(
      EnvValidationError,
    );
    const ok = loadEnv({ ...baseEnv, CHECKR_REQUEST_TIMEOUT_MS: '15000' });
    expect(ok.CHECKR_REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it('rejects a BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY shorter than 32 chars', () => {
    expect(() =>
      loadEnv({ ...baseEnv, BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY: 'short' }),
    ).toThrow(EnvValidationError);
  });

  it('rejects a PROVIDER_DISCOVERY_INTERNAL_API_KEY shorter than 32 chars (TS-053)', () => {
    expect(() => loadEnv({ ...baseEnv, PROVIDER_DISCOVERY_INTERNAL_API_KEY: 'short' })).toThrow(
      EnvValidationError,
    );
  });

  it('throws EnvValidationError when PROVIDER_DISCOVERY_INTERNAL_API_KEY is missing (TS-053)', () => {
    const { PROVIDER_DISCOVERY_INTERNAL_API_KEY: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('defaults PROVIDER_DISCOVERY_INTERNAL_HEADER_NAME (TS-053)', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.PROVIDER_DISCOVERY_INTERNAL_HEADER_NAME).toBe(
      'x-provider-discovery-internal-api-key',
    );
  });

  // ─── Observability (TS-050-followup-1) ────────────────────────────────

  it('defaults OTEL_TRACES_ENABLED + OTEL_METRICS_ENABLED to true', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.OTEL_TRACES_ENABLED).toBe(true);
    expect(env.OTEL_METRICS_ENABLED).toBe(true);
  });

  it('coerces OTEL_TRACES_ENABLED from string "false" to boolean false', () => {
    const env = loadEnv({ ...baseEnv, OTEL_TRACES_ENABLED: 'false' });
    expect(env.OTEL_TRACES_ENABLED).toBe(false);
  });

  it('coerces OTEL_METRICS_ENABLED from string "true" to boolean true', () => {
    const env = loadEnv({ ...baseEnv, OTEL_METRICS_ENABLED: 'true' });
    expect(env.OTEL_METRICS_ENABLED).toBe(true);
  });

  it('makes OTEL_EXPORTER_OTLP_ENDPOINT optional', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('accepts an explicit OTEL_EXPORTER_OTLP_ENDPOINT URL', () => {
    const env = loadEnv({
      ...baseEnv,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.observability.svc:4318',
    });
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://collector.observability.svc:4318');
  });

  it('rejects a non-URL OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    expect(() => loadEnv({ ...baseEnv, OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });

  it('treats OTEL_TRACES_ENABLED case-insensitively (string "TRUE" / "False")', () => {
    expect(loadEnv({ ...baseEnv, OTEL_TRACES_ENABLED: 'TRUE' }).OTEL_TRACES_ENABLED).toBe(true);
    expect(loadEnv({ ...baseEnv, OTEL_METRICS_ENABLED: 'False' }).OTEL_METRICS_ENABLED).toBe(false);
  });
});
