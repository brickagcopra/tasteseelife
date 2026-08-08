import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * A minimal valid environment for service-concierge. `DATABASE_URL`,
 * `JWT_ACCESS_SECRET` (TS-222), and `REDIS_URL` (TS-222) are required
 * without a default; everything else has a sane default so a bare-bones
 * dev process boots.
 */
function validEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/concierge_test',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    ...overrides,
  };
}

describe('loadEnv', () => {
  it('parses a minimal valid environment and applies defaults', () => {
    const env = loadEnv(validEnv());

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3021);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.DATABASE_URL).toBe('postgresql://test:test@localhost:5432/concierge_test');
  });

  it('applies the TS-222 auth + idempotency defaults', () => {
    const env = loadEnv(validEnv());

    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(60);
  });

  it('applies the TS-225 PagerDuty defaults (routing key optional)', () => {
    const env = loadEnv(validEnv());

    expect(env.PAGERDUTY_ROUTING_KEY).toBeUndefined();
    expect(env.PAGERDUTY_EVENTS_URL).toBe('https://events.pagerduty.com/v2/enqueue');
    expect(env.PAGERDUTY_SOURCE).toBe('service-concierge');
    expect(env.PAGERDUTY_TIMEOUT_MS).toBe(5_000);
  });

  it('accepts a configured PagerDuty routing key + overrides', () => {
    const env = loadEnv(
      validEnv({
        PAGERDUTY_ROUTING_KEY: 'rk_' + 'a'.repeat(30),
        PAGERDUTY_EVENTS_URL: 'https://events.eu.pagerduty.com/v2/enqueue',
        PAGERDUTY_SOURCE: 'concierge-prod',
        PAGERDUTY_TIMEOUT_MS: '8000',
      }),
    );

    expect(env.PAGERDUTY_ROUTING_KEY).toBe('rk_' + 'a'.repeat(30));
    expect(env.PAGERDUTY_EVENTS_URL).toBe('https://events.eu.pagerduty.com/v2/enqueue');
    expect(env.PAGERDUTY_SOURCE).toBe('concierge-prod');
    expect(env.PAGERDUTY_TIMEOUT_MS).toBe(8000);
  });

  it('rejects a non-URL PAGERDUTY_EVENTS_URL', () => {
    expect(() => loadEnv(validEnv({ PAGERDUTY_EVENTS_URL: 'not-a-url' }))).toThrow(
      EnvValidationError,
    );
  });

  it('applies the TS-226 transportation webhook defaults (api key optional, header defaulted)', () => {
    const env = loadEnv(validEnv());

    expect(env.CONCIERGE_TRANSPORTATION_INTERNAL_API_KEY).toBeUndefined();
    expect(env.CONCIERGE_TRANSPORTATION_INTERNAL_HEADER_NAME).toBe(
      'x-concierge-transportation-internal-api-key',
    );
  });

  it('accepts a configured transportation webhook key + custom header', () => {
    const env = loadEnv(
      validEnv({
        CONCIERGE_TRANSPORTATION_INTERNAL_API_KEY: 't'.repeat(40),
        CONCIERGE_TRANSPORTATION_INTERNAL_HEADER_NAME: 'x-tns-ride',
      }),
    );

    expect(env.CONCIERGE_TRANSPORTATION_INTERNAL_API_KEY).toBe('t'.repeat(40));
    expect(env.CONCIERGE_TRANSPORTATION_INTERNAL_HEADER_NAME).toBe('x-tns-ride');
  });

  it('rejects a transportation webhook key shorter than 32 chars', () => {
    expect(() => loadEnv(validEnv({ CONCIERGE_TRANSPORTATION_INTERNAL_API_KEY: 'short' }))).toThrow(
      EnvValidationError,
    );
  });

  it('throws EnvValidationError when JWT_ACCESS_SECRET is shorter than 32 chars', () => {
    expect(() => loadEnv(validEnv({ JWT_ACCESS_SECRET: 'short' }))).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when REDIS_URL is not a URL', () => {
    expect(() => loadEnv(validEnv({ REDIS_URL: 'not-a-url' }))).toThrow(EnvValidationError);
  });

  it('coerces the idempotency TTLs from strings', () => {
    const env = loadEnv(
      validEnv({ IDEMPOTENCY_TTL_SECONDS: '120', IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: '30' }),
    );

    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(120);
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
