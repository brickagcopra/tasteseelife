import { describe, expect, it } from 'vitest';

import { EnvValidationError, isStripeStubMode, loadEnv } from './env';

/**
 * Env validation is the boot-time gate (CLAUDE.md §17.11). The test
 * surface is small but load-bearing — every other module assumes a
 * validated `Env`.
 */
describe('loadEnv', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    STRIPE_EVENTS_API_KEY: 'k'.repeat(40),
    PAYOUT_TRANSFERS_API_KEY: 't'.repeat(40),
  } as const;

  it('accepts a well-formed environment and applies defaults', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.DATABASE_URL).toBe(baseEnv.DATABASE_URL);
    expect(env.PORT).toBe(3029);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.STRIPE_API_VERSION).toBe('2024-12-18.acacia');
    expect(env.STRIPE_STUB_ONBOARDING_BASE_URL).toBe(
      'https://stub-onboarding.tasteandsee.example.com',
    );
    expect(env.STRIPE_EVENTS_HEADER_NAME).toBe('x-internal-api-key');
    expect(env.STRIPE_EVENTS_API_KEY).toBe(baseEnv.STRIPE_EVENTS_API_KEY);
    expect(env.PAYOUT_HOLD_DAYS).toBe(2);
    expect(env.PAYOUT_MIN_AMOUNT_MINOR).toBe(100);
    expect(env.PAYOUT_DEFAULT_CURRENCY).toBe('USD');
    expect(env.PAYOUT_TRANSFERS_HEADER_NAME).toBe('x-internal-api-key');
    expect(env.PAYOUT_TRANSFERS_API_KEY).toBe(baseEnv.PAYOUT_TRANSFERS_API_KEY);
  });

  it('throws EnvValidationError when PAYOUT_TRANSFERS_API_KEY is too short', () => {
    expect(() => loadEnv({ ...baseEnv, PAYOUT_TRANSFERS_API_KEY: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('coerces PAYOUT_HOLD_DAYS from a string', () => {
    const env = loadEnv({ ...baseEnv, PAYOUT_HOLD_DAYS: '0' });
    expect(env.PAYOUT_HOLD_DAYS).toBe(0);
  });

  it('rejects a negative PAYOUT_HOLD_DAYS', () => {
    expect(() => loadEnv({ ...baseEnv, PAYOUT_HOLD_DAYS: '-1' })).toThrow(EnvValidationError);
  });

  it('rejects PAYOUT_HOLD_DAYS > 30', () => {
    expect(() => loadEnv({ ...baseEnv, PAYOUT_HOLD_DAYS: '31' })).toThrow(EnvValidationError);
  });

  it('rejects lower-case PAYOUT_DEFAULT_CURRENCY', () => {
    expect(() => loadEnv({ ...baseEnv, PAYOUT_DEFAULT_CURRENCY: 'usd' })).toThrow(
      EnvValidationError,
    );
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

  it('throws EnvValidationError when STRIPE_EVENTS_API_KEY is missing', () => {
    const { STRIPE_EVENTS_API_KEY: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when STRIPE_EVENTS_API_KEY is too short', () => {
    expect(() => loadEnv({ ...baseEnv, STRIPE_EVENTS_API_KEY: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('accepts a live Stripe key', () => {
    const env = loadEnv({ ...baseEnv, STRIPE_SECRET_KEY: 'sk_test_live_abc' });
    expect(env.STRIPE_SECRET_KEY).toBe('sk_test_live_abc');
    expect(isStripeStubMode(env)).toBe(false);
  });

  it('forces stub mode when STRIPE_SECRET_KEY is absent', () => {
    const env = loadEnv({ ...baseEnv });
    expect(isStripeStubMode(env)).toBe(true);
  });

  it('forces stub mode for the sk_test_stub_* sentinel', () => {
    const env = loadEnv({ ...baseEnv, STRIPE_SECRET_KEY: 'sk_test_stub_anything' });
    expect(isStripeStubMode(env)).toBe(true);
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

  it('accepts a custom STRIPE_EVENTS_HEADER_NAME override', () => {
    const env = loadEnv({ ...baseEnv, STRIPE_EVENTS_HEADER_NAME: 'x-tns-stripe' });
    expect(env.STRIPE_EVENTS_HEADER_NAME).toBe('x-tns-stripe');
  });

  it('accepts a custom STRIPE_STUB_ONBOARDING_BASE_URL override', () => {
    const env = loadEnv({
      ...baseEnv,
      STRIPE_STUB_ONBOARDING_BASE_URL: 'https://example.test/onboard',
    });
    expect(env.STRIPE_STUB_ONBOARDING_BASE_URL).toBe('https://example.test/onboard');
  });

  it('rejects a malformed STRIPE_STUB_ONBOARDING_BASE_URL', () => {
    expect(() => loadEnv({ ...baseEnv, STRIPE_STUB_ONBOARDING_BASE_URL: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });
});
