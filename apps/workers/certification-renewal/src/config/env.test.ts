import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * A minimal valid environment for worker-certification-renewal. The three
 * base URLs + three shared secrets are required (no default); everything
 * else has a sane default so a bare-bones dev process boots.
 */
function validEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ACADEMY_SERVICE_BASE_URL: 'http://service-academy:3022',
    ACADEMY_CERTIFICATION_RENEWALS_API_KEY: 'a'.repeat(32),
    IDENTITY_SERVICE_BASE_URL: 'http://service-identity:3011',
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: 'i'.repeat(32),
    NOTIFICATION_SERVICE_BASE_URL: 'http://service-notification:3017',
    NOTIFICATION_DISPATCH_API_KEY: 'n'.repeat(32),
    ...overrides,
  };
}

describe('loadEnv', () => {
  it('parses a minimal valid environment and applies defaults', () => {
    const env = loadEnv(validEnv());

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3057);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(env.CERTIFICATION_RENEWAL_ENABLED).toBe(true);
    expect(env.CERTIFICATION_RENEWAL_RUN_HOUR_UTC).toBe(14);
    expect(env.CERTIFICATION_RENEWAL_SCHEDULER_TICK_MS).toBe(3_600_000);
    expect(env.CERTIFICATION_RENEWAL_PAGE_LIMIT).toBe(100);
    expect(env.CERTIFICATION_RENEWAL_HORIZON_DAYS).toBe(90);
    expect(env.CERTIFICATION_RENEWAL_RENEW_URL).toBe(
      'https://academy.tasteandsee.example.com/renewals',
    );
    expect(env.CERTIFICATION_RENEWAL_APP_NAME).toBe('Taste & See');
    expect(env.ACADEMY_CERTIFICATION_RENEWALS_HEADER_NAME).toBe('x-internal-api-key');
  });

  it('coerces numeric envs and honours overrides', () => {
    const env = loadEnv(
      validEnv({
        PORT: '4000',
        CERTIFICATION_RENEWAL_RUN_HOUR_UTC: '6',
        CERTIFICATION_RENEWAL_PAGE_LIMIT: '250',
        CERTIFICATION_RENEWAL_HORIZON_DAYS: '120',
      }),
    );
    expect(env.PORT).toBe(4000);
    expect(env.CERTIFICATION_RENEWAL_RUN_HOUR_UTC).toBe(6);
    expect(env.CERTIFICATION_RENEWAL_PAGE_LIMIT).toBe(250);
    expect(env.CERTIFICATION_RENEWAL_HORIZON_DAYS).toBe(120);
  });

  it('parses the kill-switch from a string boolean', () => {
    expect(
      loadEnv(validEnv({ CERTIFICATION_RENEWAL_ENABLED: 'false' })).CERTIFICATION_RENEWAL_ENABLED,
    ).toBe(false);
    expect(
      loadEnv(validEnv({ CERTIFICATION_RENEWAL_ENABLED: 'true' })).CERTIFICATION_RENEWAL_ENABLED,
    ).toBe(true);
  });

  it('throws when a required base URL is missing or malformed', () => {
    expect(() => loadEnv({ ...validEnv(), ACADEMY_SERVICE_BASE_URL: undefined })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv(validEnv({ IDENTITY_SERVICE_BASE_URL: 'not-a-url' }))).toThrow(
      EnvValidationError,
    );
  });

  it('throws when a shared secret is shorter than 32 characters', () => {
    expect(() => loadEnv(validEnv({ ACADEMY_CERTIFICATION_RENEWALS_API_KEY: 'short' }))).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv(validEnv({ NOTIFICATION_DISPATCH_API_KEY: 'short' }))).toThrow(
      EnvValidationError,
    );
  });

  it('rejects an out-of-range run hour', () => {
    expect(() => loadEnv(validEnv({ CERTIFICATION_RENEWAL_RUN_HOUR_UTC: '24' }))).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a horizon over the cap', () => {
    expect(() => loadEnv(validEnv({ CERTIFICATION_RENEWAL_HORIZON_DAYS: '400' }))).toThrow(
      EnvValidationError,
    );
  });

  it('rejects an invalid renew URL', () => {
    expect(() => loadEnv(validEnv({ CERTIFICATION_RENEWAL_RENEW_URL: 'nope' }))).toThrow(
      EnvValidationError,
    );
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
      expect((err as EnvValidationError).message).toContain('ACADEMY_SERVICE_BASE_URL');
      expect((err as EnvValidationError).issues.length).toBeGreaterThan(0);
    }
  });
});
