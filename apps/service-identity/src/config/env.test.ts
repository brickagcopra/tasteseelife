import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * Env validation is the boot-time gate (CLAUDE.md §17.11 — never
 * hardcode environment-dependent values). The test surface is small but
 * load-bearing — every other module assumes a validated `Env`.
 *
 * Surface today:
 *   - TS-020 — DATABASE_URL + standard NODE_ENV/PORT/etc.
 *   - TS-022 — JWT_ACCESS_SECRET (HS256 minimum 32 chars).
 *   - TS-023 — MFA cluster (TOTP enc key, challenge secret, RFC 6238 knobs).
 *   - TS-044-followup-2 — REDIS_URL + idempotency TTLs.
 *   - TS-026 — KYC cluster (Stripe key, Identity return URL, payload enc
 *     key, internal-dispatch API key).
 *
 * The new-key tests live in their own describe blocks so a future env
 * addition doesn't sprawl across the file.
 */
describe('loadEnv', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    MFA_TOTP_ENC_KEY: randomBytes(32).toString('base64'),
    MFA_CHALLENGE_SECRET: 'b'.repeat(32),
    REDIS_URL: 'redis://localhost:6379/0',
    STRIPE_SECRET_KEY: 'sk_test_' + 'x'.repeat(24),
    STRIPE_IDENTITY_RETURN_URL: 'https://app.tasteandsee.com/onboarding/identity/complete',
    KYC_PAYLOAD_ENC_KEY: randomBytes(32).toString('base64'),
    KYC_WEBHOOK_INTERNAL_API_KEY: 'c'.repeat(48),
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: 'd'.repeat(48),
    IDENTITY_PRIVACY_EXPORT_API_KEY: 'e'.repeat(48),
  } as const;

  it('accepts a well-formed environment and applies defaults', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.DATABASE_URL).toBe(baseEnv.DATABASE_URL);
    expect(env.PORT).toBe(3010);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(env.JWT_REFRESH_TTL_SECONDS).toBe(60 * 60 * 24 * 30);
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.REFRESH_COOKIE_SECURE).toBe(true);
    expect(env.MFA_TOTP_ENC_KEY_VERSION).toBe(1);
    expect(env.MFA_CHALLENGE_TTL_SECONDS).toBe(300);
    expect(env.MFA_TOTP_PERIOD_SECONDS).toBe(30);
    expect(env.MFA_TOTP_DIGITS).toBe(6);
    expect(env.MFA_TOTP_WINDOW).toBe(1);
    expect(env.MFA_TOTP_ISSUER).toBe('Taste & See');
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

  it('boots against a realistic Kubernetes pod env (the TS-153 regression)', () => {
    // Before TS-153 the `.strict()` schema was validated against the raw
    // process.env, so the ambient + Kubernetes-injected keys below tripped
    // `unrecognized_keys` and CrashLooped EVERY pod at boot. This is the
    // exact env shape a pod sees: ambient shell vars, the Deployment's
    // downward-API POD_* vars, and the env var Kubernetes injects for every
    // Service in the namespace (<NAME>_SERVICE_HOST / _PORT).
    const podEnv = {
      ...baseEnv,
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/node',
      HOSTNAME: 'service-identity-7d9f8c-abcde',
      NODE_VERSION: '22.20.0',
      POD_NAME: 'service-identity-7d9f8c-abcde',
      POD_NAMESPACE: 'platform-services',
      POD_IP: '10.42.1.7',
      KUBERNETES_SERVICE_HOST: '10.43.0.1',
      KUBERNETES_SERVICE_PORT: '443',
      SERVICE_SUBSCRIPTION_SERVICE_HOST: '10.43.2.5',
      SERVICE_SUBSCRIPTION_SERVICE_PORT: '3012',
    };
    expect(() => loadEnv(podEnv)).not.toThrow();
    const env = loadEnv(podEnv);
    // Declared config is still parsed + coerced (PORT default applied);
    // the ambient / k8s-injected keys are stripped from the result.
    expect(env.DATABASE_URL).toBe(baseEnv.DATABASE_URL);
    expect(env.PORT).toBe(3010);
    expect((env as Record<string, unknown>).KUBERNETES_SERVICE_HOST).toBeUndefined();
    expect((env as Record<string, unknown>).POD_NAME).toBeUndefined();
  });

  it('exposes structured issues on the thrown error', () => {
    try {
      loadEnv({});
      throw new Error('loadEnv unexpectedly succeeded');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const issues = (err as EnvValidationError).issues;
      expect(Array.isArray(issues)).toBe(true);
      const paths = issues.flatMap((issue) => issue.path);
      expect(paths).toContain('DATABASE_URL');
      expect(paths).toContain('JWT_ACCESS_SECRET');
      expect(paths).toContain('MFA_TOTP_ENC_KEY');
      expect(paths).toContain('MFA_CHALLENGE_SECRET');
      expect(paths).toContain('REDIS_URL');
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

  // ─── TS-022 additions ──────────────────────────────────────────────

  it('requires JWT_ACCESS_SECRET and enforces a length floor', () => {
    const { JWT_ACCESS_SECRET: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, JWT_ACCESS_SECRET: 'a'.repeat(31) })).toThrow(
      EnvValidationError,
    );
  });

  // ─── TS-023 additions ──────────────────────────────────────────────

  it('requires MFA_TOTP_ENC_KEY to decode to exactly 32 bytes', () => {
    // 16 bytes (AES-128 size) is the canonical "looks plausible but wrong" case.
    const shortKey = randomBytes(16).toString('base64');
    expect(() => loadEnv({ ...baseEnv, MFA_TOTP_ENC_KEY: shortKey })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, MFA_TOTP_ENC_KEY: '' })).toThrow(EnvValidationError);
  });

  it('requires MFA_CHALLENGE_SECRET and enforces a length floor', () => {
    const { MFA_CHALLENGE_SECRET: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, MFA_CHALLENGE_SECRET: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('uses INDEPENDENT JWT and MFA challenge secrets (no shared default)', () => {
    // Pins the threat-model rationale documented in env.ts — a leaked
    // access-token signing key must NOT also grant the ability to mint
    // an MFA challenge that bypasses the second factor.
    const env = loadEnv({ ...baseEnv });
    expect(env.MFA_CHALLENGE_SECRET).not.toBe(env.JWT_ACCESS_SECRET);
  });

  // ─── TS-044-followup-2 additions (REDIS_URL + idempotency TTLs) ────

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

  // ─── TS-293 additions (rbac-revoker sweep) ─────────────────────────

  it('defaults the rbac-revoker cluster (enabled, 5-minute interval, 500-row batches)', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.RBAC_REVOKER_ENABLED).toBe(true);
    expect(env.RBAC_REVOKER_INTERVAL_MS).toBe(300_000);
    expect(env.RBAC_REVOKER_BATCH_SIZE).toBe(500);
  });

  it('parses RBAC_REVOKER_ENABLED=false from the string form', () => {
    const env = loadEnv({ ...baseEnv, RBAC_REVOKER_ENABLED: 'false' });
    expect(env.RBAC_REVOKER_ENABLED).toBe(false);
  });

  it('rejects a non-positive rbac-revoker interval and an oversized batch', () => {
    expect(() => loadEnv({ ...baseEnv, RBAC_REVOKER_INTERVAL_MS: '0' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...baseEnv, RBAC_REVOKER_BATCH_SIZE: '50000' })).toThrow(
      EnvValidationError,
    );
  });

  // ─── TS-026 additions (Stripe + KYC cluster) ───────────────────────

  it('requires STRIPE_SECRET_KEY and enforces a length floor', () => {
    const { STRIPE_SECRET_KEY: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, STRIPE_SECRET_KEY: 'sk_test_short' })).toThrow(
      EnvValidationError,
    );
  });

  it('makes STRIPE_API_VERSION optional', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.STRIPE_API_VERSION).toBeUndefined();
  });

  it('accepts an explicit STRIPE_API_VERSION pin', () => {
    const env = loadEnv({ ...baseEnv, STRIPE_API_VERSION: '2024-06-20' });
    expect(env.STRIPE_API_VERSION).toBe('2024-06-20');
  });

  it('requires STRIPE_IDENTITY_RETURN_URL and rejects non-URL values', () => {
    const { STRIPE_IDENTITY_RETURN_URL: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, STRIPE_IDENTITY_RETURN_URL: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });

  it('requires KYC_PAYLOAD_ENC_KEY to decode to exactly 32 bytes', () => {
    const shortKey = randomBytes(16).toString('base64');
    expect(() => loadEnv({ ...baseEnv, KYC_PAYLOAD_ENC_KEY: shortKey })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...baseEnv, KYC_PAYLOAD_ENC_KEY: '' })).toThrow(EnvValidationError);
  });

  it('defaults KYC_PAYLOAD_ENC_KEY_VERSION to 1', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.KYC_PAYLOAD_ENC_KEY_VERSION).toBe(1);
  });

  it('coerces KYC_PAYLOAD_ENC_KEY_VERSION from string to integer', () => {
    const env = loadEnv({ ...baseEnv, KYC_PAYLOAD_ENC_KEY_VERSION: '3' });
    expect(env.KYC_PAYLOAD_ENC_KEY_VERSION).toBe(3);
  });

  it('uses INDEPENDENT KYC and MFA payload-encryption keys (no shared default)', () => {
    // Pins the threat-model rationale documented in env.ts — a leaked
    // MFA cipher key must NOT also grant the ability to read every KYC
    // row.
    const env = loadEnv({ ...baseEnv });
    expect(env.KYC_PAYLOAD_ENC_KEY).not.toBe(env.MFA_TOTP_ENC_KEY);
  });

  it('requires KYC_WEBHOOK_INTERNAL_API_KEY and enforces a length floor', () => {
    const { KYC_WEBHOOK_INTERNAL_API_KEY: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, KYC_WEBHOOK_INTERNAL_API_KEY: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  // ─── TS-235 additions (recipient-contacts shared secret) ───────────

  it('requires IDENTITY_RECIPIENT_CONTACTS_API_KEY and enforces a length floor', () => {
    const { IDENTITY_RECIPIENT_CONTACTS_API_KEY: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, IDENTITY_RECIPIENT_CONTACTS_API_KEY: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('accepts a well-formed IDENTITY_RECIPIENT_CONTACTS_API_KEY (32+ chars)', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.IDENTITY_RECIPIENT_CONTACTS_API_KEY).toBe('d'.repeat(48));
  });

  it('defaults IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME to x-internal-api-key', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME).toBe('x-internal-api-key');
  });

  it('accepts an explicit IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME override', () => {
    const env = loadEnv({
      ...baseEnv,
      IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: 'x-wellness-summary-key',
    });
    expect(env.IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME).toBe('x-wellness-summary-key');
  });

  it('rejects an empty IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME', () => {
    expect(() => loadEnv({ ...baseEnv, IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: '' })).toThrow(
      EnvValidationError,
    );
  });

  // ─── TS-309b additions (privacy-export shared secret) ──────────────

  it('requires IDENTITY_PRIVACY_EXPORT_API_KEY and enforces a length floor', () => {
    const { IDENTITY_PRIVACY_EXPORT_API_KEY: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, IDENTITY_PRIVACY_EXPORT_API_KEY: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('keeps the privacy-export secret distinct from the recipient-contacts one', () => {
    // Two routes, two secrets: one leaked value must not open both.
    const env = loadEnv({ ...baseEnv });
    expect(env.IDENTITY_PRIVACY_EXPORT_API_KEY).toBe('e'.repeat(48));
    expect(env.IDENTITY_PRIVACY_EXPORT_API_KEY).not.toBe(env.IDENTITY_RECIPIENT_CONTACTS_API_KEY);
  });

  it('defaults IDENTITY_PRIVACY_EXPORT_HEADER_NAME to x-internal-api-key', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.IDENTITY_PRIVACY_EXPORT_HEADER_NAME).toBe('x-internal-api-key');
  });

  it('accepts an explicit IDENTITY_PRIVACY_EXPORT_HEADER_NAME override', () => {
    const env = loadEnv({ ...baseEnv, IDENTITY_PRIVACY_EXPORT_HEADER_NAME: 'x-privacy-key' });
    expect(env.IDENTITY_PRIVACY_EXPORT_HEADER_NAME).toBe('x-privacy-key');
  });

  it('rejects an empty IDENTITY_PRIVACY_EXPORT_HEADER_NAME', () => {
    expect(() => loadEnv({ ...baseEnv, IDENTITY_PRIVACY_EXPORT_HEADER_NAME: '' })).toThrow(
      EnvValidationError,
    );
  });

  // ─── TS-020-followup-1 additions (OTel observability) ──────────────

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

  // ─── TS-025-followup-1 additions (login IP circuit breaker) ────────

  it('defaults LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW to 30 (CLAUDE.md §3.1 example)', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW).toBe(30);
  });

  it('defaults LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS to 300 (5 minutes)', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS).toBe(300);
  });

  it('coerces LOGIN_IP_RATE_LIMIT_* overrides from string to integer', () => {
    const env = loadEnv({
      ...baseEnv,
      LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW: '60',
      LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS: '120',
    });
    expect(env.LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW).toBe(60);
    expect(env.LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS).toBe(120);
  });

  it('rejects non-positive LOGIN_IP_RATE_LIMIT_* values', () => {
    expect(() => loadEnv({ ...baseEnv, LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW: '0' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...baseEnv, LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS: '-1' })).toThrow(
      EnvValidationError,
    );
  });
});
