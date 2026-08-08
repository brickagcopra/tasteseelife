import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * Env validation is the boot-time gate (CLAUDE.md §17.11 — never
 * hardcode environment-dependent values). The test surface is small
 * but load-bearing — every other module assumes a validated `Env`.
 *
 * TS-072 ships skeleton + JWT verification + internal-render shared
 * secret. Each cluster is exercised below.
 */
describe('loadEnv', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    NOTIFICATION_RENDER_API_KEY: 'k'.repeat(40),
    NOTIFICATION_DISPATCH_API_KEY: 'd'.repeat(40),
    // TS-042-followup-3a2 — the dunning-consumer cluster. All six are
    // required with no default: a mailer that cannot reach Redis, the
    // household resolver or identity cannot send the ladder at all, and a
    // pod that booted anyway would look healthy while silently mailing
    // nobody.
    REDIS_URL: 'redis://localhost:6379',
    HOUSEHOLD_SERVICE_BASE_URL: 'http://service-household:3011',
    PROVIDER_SERVICE_BASE_URL: 'http://service-household:3011',
    PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY: 'p'.repeat(48),
    PROVIDER_BILLING_CONTACTS_INTERNAL_HEADER_NAME: 'x-provider-billing-contacts-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY: 'h'.repeat(32),
    IDENTITY_SERVICE_BASE_URL: 'http://service-identity:3010',
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: 'i'.repeat(32),
    DUNNING_BILLING_URL: 'https://app.example.com/billing/invoices',
  } as const;

  it('accepts a well-formed environment and applies defaults', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.DATABASE_URL).toBe(baseEnv.DATABASE_URL);
    expect(env.PORT).toBe(3028);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.NOTIFICATION_RENDER_HEADER_NAME).toBe('x-internal-api-key');
    expect(env.NOTIFICATION_RENDER_API_KEY).toBe(baseEnv.NOTIFICATION_RENDER_API_KEY);
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

  it('throws EnvValidationError when NOTIFICATION_RENDER_API_KEY is missing', () => {
    const { NOTIFICATION_RENDER_API_KEY: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when NOTIFICATION_RENDER_API_KEY is too short', () => {
    expect(() => loadEnv({ ...baseEnv, NOTIFICATION_RENDER_API_KEY: 'too-short' })).toThrow(
      EnvValidationError,
    );
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

  it('accepts a custom NOTIFICATION_RENDER_HEADER_NAME override', () => {
    const env = loadEnv({ ...baseEnv, NOTIFICATION_RENDER_HEADER_NAME: 'x-tns-render' });
    expect(env.NOTIFICATION_RENDER_HEADER_NAME).toBe('x-tns-render');
  });

  it('throws EnvValidationError when NOTIFICATION_DISPATCH_API_KEY is missing', () => {
    const { NOTIFICATION_DISPATCH_API_KEY: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when NOTIFICATION_DISPATCH_API_KEY is too short', () => {
    expect(() => loadEnv({ ...baseEnv, NOTIFICATION_DISPATCH_API_KEY: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('treats POSTMARK_SERVER_TOKEN as optional (stub mode default)', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.POSTMARK_SERVER_TOKEN).toBeUndefined();
    expect(env.TWILIO_ACCOUNT_SID).toBeUndefined();
    expect(env.FIREBASE_SERVICE_ACCOUNT_B64).toBeUndefined();
  });

  it('accepts populated channel SDK credentials', () => {
    const env = loadEnv({
      ...baseEnv,
      POSTMARK_SERVER_TOKEN: 'pm-token',
      TWILIO_ACCOUNT_SID: 'AC' + 'x'.repeat(20),
      TWILIO_AUTH_TOKEN: 'tw-token',
      NOTIFICATION_SMS_FROM_NUMBER: '+12025550100',
      FIREBASE_SERVICE_ACCOUNT_B64: Buffer.from('{}').toString('base64'),
      FIREBASE_PROJECT_ID: 'tns-prod',
    });
    expect(env.POSTMARK_SERVER_TOKEN).toBe('pm-token');
    expect(env.TWILIO_ACCOUNT_SID).toMatch(/^AC/);
  });

  it('applies sensible defaults for NOTIFICATION_EMAIL_FROM_ADDRESS / NAME', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.NOTIFICATION_EMAIL_FROM_ADDRESS).toBe('no-reply@tasteandsee.example.com');
    expect(env.NOTIFICATION_EMAIL_FROM_NAME).toBe('Taste & See');
  });

  it('rejects malformed NOTIFICATION_EMAIL_FROM_ADDRESS', () => {
    expect(() => loadEnv({ ...baseEnv, NOTIFICATION_EMAIL_FROM_ADDRESS: 'not-an-email' })).toThrow(
      EnvValidationError,
    );
  });

  it('exposes the issues array on EnvValidationError', () => {
    try {
      loadEnv({ ...baseEnv, JWT_ACCESS_SECRET: 'short' });
      expect.fail('expected validation to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      if (err instanceof EnvValidationError) {
        expect(err.issues.length).toBeGreaterThan(0);
        expect(err.issues.some((i) => i.path.join('.') === 'JWT_ACCESS_SECRET')).toBe(true);
      }
    }
  });
});
