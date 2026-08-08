import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * Env validation is the boot-time gate (CLAUDE.md §17.11). For
 * service-webhook specifically, the gate carries unusual weight: the
 * Stripe webhook signing secret is THE security boundary — there is no
 * other authentication mechanism on the inbound webhook path. A
 * misconfigured pod that boots without it would ack 200 to arbitrary
 * payloads. The schema makes the secret mandatory; these tests pin that
 * contract.
 */
describe('loadEnv', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_aaaaaaaaaaaaaaaaaaaa',
    // TS-051 — Checkr webhook secret is required at boot (mirrors
    // STRIPE_WEBHOOK_SECRET — there's no other auth boundary on the
    // Checkr inbound path).
    CHECKR_WEBHOOK_SECRET: 'whsec_test_checkr_bbbbbbbbbbbbbb',
  } as const;

  it('accepts a well-formed environment and applies defaults', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.DATABASE_URL).toBe(baseEnv.DATABASE_URL);
    expect(env.STRIPE_WEBHOOK_SECRET).toBe(baseEnv.STRIPE_WEBHOOK_SECRET);
    expect(env.PORT).toBe(3013);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.STRIPE_WEBHOOK_TOLERANCE_SECONDS).toBe(300);
    expect(env.STRIPE_API_VERSION).toBeUndefined();
  });

  it('throws EnvValidationError when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
  });

  it('rejects a non-URL DATABASE_URL', () => {
    expect(() => loadEnv({ ...baseEnv, DATABASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when STRIPE_WEBHOOK_SECRET is missing', () => {
    const { STRIPE_WEBHOOK_SECRET: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
  });

  it('rejects a too-short STRIPE_WEBHOOK_SECRET (typo / empty-string guard)', () => {
    expect(() => loadEnv({ ...baseEnv, STRIPE_WEBHOOK_SECRET: 'whsec_short' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...baseEnv, STRIPE_WEBHOOK_SECRET: '' })).toThrow(EnvValidationError);
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

  it('honours an overridden STRIPE_WEBHOOK_TOLERANCE_SECONDS within [60, 900]', () => {
    expect(
      loadEnv({ ...baseEnv, STRIPE_WEBHOOK_TOLERANCE_SECONDS: '60' })
        .STRIPE_WEBHOOK_TOLERANCE_SECONDS,
    ).toBe(60);
    expect(
      loadEnv({ ...baseEnv, STRIPE_WEBHOOK_TOLERANCE_SECONDS: '900' })
        .STRIPE_WEBHOOK_TOLERANCE_SECONDS,
    ).toBe(900);
  });

  it('rejects a STRIPE_WEBHOOK_TOLERANCE_SECONDS outside [60, 900]', () => {
    expect(() => loadEnv({ ...baseEnv, STRIPE_WEBHOOK_TOLERANCE_SECONDS: '59' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...baseEnv, STRIPE_WEBHOOK_TOLERANCE_SECONDS: '901' })).toThrow(
      EnvValidationError,
    );
  });

  it('accepts a STRIPE_API_VERSION when supplied and otherwise leaves it undefined', () => {
    const withVersion = loadEnv({ ...baseEnv, STRIPE_API_VERSION: '2025-09-30.basil' });
    expect(withVersion.STRIPE_API_VERSION).toBe('2025-09-30.basil');
    const withoutVersion = loadEnv({ ...baseEnv });
    expect(withoutVersion.STRIPE_API_VERSION).toBeUndefined();
  });

  it('rejects an empty-string STRIPE_API_VERSION', () => {
    expect(() => loadEnv({ ...baseEnv, STRIPE_API_VERSION: '' })).toThrow(EnvValidationError);
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
      expect(issues.some((issue) => issue.path.includes('STRIPE_WEBHOOK_SECRET'))).toBe(true);
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

  // ─── TS-026 additions (KYC dispatch cluster) ────────────────────────

  it('leaves KYC dispatch undefined when neither URL nor API key set', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.KYC_DISPATCH_URL).toBeUndefined();
    expect(env.KYC_DISPATCH_API_KEY).toBeUndefined();
    expect(env.KYC_DISPATCH_TIMEOUT_MS).toBe(5_000);
  });

  it('accepts both KYC dispatch values when set together', () => {
    const env = loadEnv({
      ...baseEnv,
      KYC_DISPATCH_URL: 'https://service-identity.internal/api/v1/internal/kyc/webhook-events',
      KYC_DISPATCH_API_KEY: 'k'.repeat(48),
    });
    expect(env.KYC_DISPATCH_URL).toBe(
      'https://service-identity.internal/api/v1/internal/kyc/webhook-events',
    );
    expect(env.KYC_DISPATCH_API_KEY).toBe('k'.repeat(48));
  });

  it('rejects half-configured KYC dispatch (URL without API key)', () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        KYC_DISPATCH_URL: 'https://service-identity.internal/api/v1/internal/kyc/webhook-events',
      }),
    ).toThrow(EnvValidationError);
  });

  it('rejects half-configured KYC dispatch (API key without URL)', () => {
    expect(() => loadEnv({ ...baseEnv, KYC_DISPATCH_API_KEY: 'k'.repeat(48) })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects too-short KYC_DISPATCH_API_KEY', () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        KYC_DISPATCH_URL: 'https://service-identity.internal/api/v1/internal/kyc/webhook-events',
        KYC_DISPATCH_API_KEY: 'too-short',
      }),
    ).toThrow(EnvValidationError);
  });

  it('rejects a non-URL KYC_DISPATCH_URL', () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        KYC_DISPATCH_URL: 'not-a-url',
        KYC_DISPATCH_API_KEY: 'k'.repeat(48),
      }),
    ).toThrow(EnvValidationError);
  });

  it('rejects KYC_DISPATCH_TIMEOUT_MS outside [500, 30000]', () => {
    expect(() => loadEnv({ ...baseEnv, KYC_DISPATCH_TIMEOUT_MS: '499' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...baseEnv, KYC_DISPATCH_TIMEOUT_MS: '30001' })).toThrow(
      EnvValidationError,
    );
  });

  // ─── TS-051 additions (Checkr inbound + bg-check dispatch) ──────────

  it('rejects a too-short CHECKR_WEBHOOK_SECRET', () => {
    expect(() => loadEnv({ ...baseEnv, CHECKR_WEBHOOK_SECRET: 'short' })).toThrow(
      EnvValidationError,
    );
  });

  it('defaults CHECKR_WEBHOOK_TOLERANCE_SECONDS to 300 and bounds [60, 900]', () => {
    expect(loadEnv({ ...baseEnv }).CHECKR_WEBHOOK_TOLERANCE_SECONDS).toBe(300);
    expect(() => loadEnv({ ...baseEnv, CHECKR_WEBHOOK_TOLERANCE_SECONDS: '59' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...baseEnv, CHECKR_WEBHOOK_TOLERANCE_SECONDS: '901' })).toThrow(
      EnvValidationError,
    );
  });

  it('leaves background-check dispatch undefined when neither URL nor API key set', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.BACKGROUND_CHECK_DISPATCH_URL).toBeUndefined();
    expect(env.BACKGROUND_CHECK_DISPATCH_API_KEY).toBeUndefined();
    expect(env.BACKGROUND_CHECK_DISPATCH_TIMEOUT_MS).toBe(5_000);
  });

  it('accepts both bg-check dispatch values when set together', () => {
    const env = loadEnv({
      ...baseEnv,
      BACKGROUND_CHECK_DISPATCH_URL:
        'https://service-provider.internal/api/v1/internal/providers/background-check-events',
      BACKGROUND_CHECK_DISPATCH_API_KEY: 'b'.repeat(48),
    });
    expect(env.BACKGROUND_CHECK_DISPATCH_URL).toBe(
      'https://service-provider.internal/api/v1/internal/providers/background-check-events',
    );
    expect(env.BACKGROUND_CHECK_DISPATCH_API_KEY).toBe('b'.repeat(48));
  });

  it('rejects half-configured bg-check dispatch (URL without API key)', () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        BACKGROUND_CHECK_DISPATCH_URL:
          'https://service-provider.internal/api/v1/internal/providers/background-check-events',
      }),
    ).toThrow(EnvValidationError);
  });

  it('rejects half-configured bg-check dispatch (API key without URL)', () => {
    expect(() =>
      loadEnv({ ...baseEnv, BACKGROUND_CHECK_DISPATCH_API_KEY: 'b'.repeat(48) }),
    ).toThrow(EnvValidationError);
  });

  it('rejects too-short BACKGROUND_CHECK_DISPATCH_API_KEY', () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        BACKGROUND_CHECK_DISPATCH_URL:
          'https://service-provider.internal/api/v1/internal/providers/background-check-events',
        BACKGROUND_CHECK_DISPATCH_API_KEY: 'too-short',
      }),
    ).toThrow(EnvValidationError);
  });

  it('rejects BACKGROUND_CHECK_DISPATCH_TIMEOUT_MS outside [500, 30000]', () => {
    expect(() => loadEnv({ ...baseEnv, BACKGROUND_CHECK_DISPATCH_TIMEOUT_MS: '499' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...baseEnv, BACKGROUND_CHECK_DISPATCH_TIMEOUT_MS: '30001' })).toThrow(
      EnvValidationError,
    );
  });

  // ─── Observability (TS-041a-followup-4) ───────────────────────────────

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
