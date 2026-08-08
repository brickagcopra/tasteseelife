import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

const REQUIRED: NodeJS.ProcessEnv = {
  JWT_ACCESS_SECRET: 'j'.repeat(32),
  INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
  REDIS_URL: 'redis://localhost:6379',
  SUBSCRIPTION_SERVICE_BASE_URL: 'http://service-subscription.local',
};

describe('loadEnv', () => {
  it('parses with the minimum required env', () => {
    const env = loadEnv(REQUIRED);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.RATE_LIMIT_DEFAULT_WINDOW_SECONDS).toBe(60);
    expect(env.RATE_LIMIT_DEFAULT_MAX_REQUESTS).toBe(120);
    expect(env.RATE_LIMIT_SENSITIVE_WINDOW_SECONDS).toBe(300);
    expect(env.RATE_LIMIT_SENSITIVE_MAX_REQUESTS).toBe(20);
    expect(env.DOWNSTREAM_REQUEST_TIMEOUT_MS).toBe(5_000);
    expect(env.INTERNAL_TRUST_MAX_AGE_SECONDS).toBe(60);
    expect(env.SUBSCRIPTION_SERVICE_BASE_URL).toBe('http://service-subscription.local');
    expect(env.IDENTITY_SERVICE_BASE_URL).toBeUndefined();
    expect(env.HOUSEHOLD_SERVICE_BASE_URL).toBeUndefined();
  });

  it('coerces PORT from string', () => {
    const env = loadEnv({ ...REQUIRED, PORT: '4000' });
    expect(env.PORT).toBe(4000);
  });

  it('rejects a short JWT secret', () => {
    expect(() => loadEnv({ ...REQUIRED, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a short internal-trust secret', () => {
    expect(() => loadEnv({ ...REQUIRED, INTERNAL_TRUST_SIGNING_SECRET: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a malformed REDIS_URL', () => {
    expect(() => loadEnv({ ...REQUIRED, REDIS_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('rejects a missing required subscription service URL', () => {
    const { SUBSCRIPTION_SERVICE_BASE_URL: _omit, ...without } = REQUIRED;
    expect(() => loadEnv(without)).toThrow(EnvValidationError);
  });

  it('rejects a malformed required subscription service URL', () => {
    expect(() =>
      loadEnv({ ...REQUIRED, SUBSCRIPTION_SERVICE_BASE_URL: 'definitely-not-a-url' }),
    ).toThrow(EnvValidationError);
  });

  it('rejects a malformed optional service URL', () => {
    expect(() => loadEnv({ ...REQUIRED, IDENTITY_SERVICE_BASE_URL: 'oops' })).toThrow(
      EnvValidationError,
    );
  });

  it('accepts a well-formed optional service URL', () => {
    const env = loadEnv({
      ...REQUIRED,
      IDENTITY_SERVICE_BASE_URL: 'http://service-identity.local',
    });
    expect(env.IDENTITY_SERVICE_BASE_URL).toBe('http://service-identity.local');
  });

  it('rejects unknown NODE_ENV', () => {
    expect(() => loadEnv({ ...REQUIRED, NODE_ENV: 'qa' })).toThrow(EnvValidationError);
  });

  it('ignores undeclared env keys (tolerates ambient / k8s-injected vars)', () => {
    // TS-153: a pod's process.env carries PATH/HOME + Kubernetes-injected
    // POD_* and <SERVICE>_SERVICE_HOST/_PORT vars; loadEnv strips undeclared
    // keys rather than CrashLoop on them at boot.
    const env = loadEnv({ ...REQUIRED, EXTRA_FIELD: 'oops' });
    expect((env as Record<string, unknown>).EXTRA_FIELD).toBeUndefined();
  });

  it('clamps downstream timeout below floor', () => {
    expect(() => loadEnv({ ...REQUIRED, DOWNSTREAM_REQUEST_TIMEOUT_MS: '250' })).toThrow(
      EnvValidationError,
    );
  });

  it('clamps downstream timeout above ceiling', () => {
    expect(() => loadEnv({ ...REQUIRED, DOWNSTREAM_REQUEST_TIMEOUT_MS: '60000' })).toThrow(
      EnvValidationError,
    );
  });

  it('clamps internal-trust max age above ceiling', () => {
    expect(() => loadEnv({ ...REQUIRED, INTERNAL_TRUST_MAX_AGE_SECONDS: '7200' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects zero / negative rate-limit values', () => {
    expect(() => loadEnv({ ...REQUIRED, RATE_LIMIT_DEFAULT_MAX_REQUESTS: '0' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...REQUIRED, RATE_LIMIT_SENSITIVE_WINDOW_SECONDS: '-1' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a non-positive PORT', () => {
    expect(() => loadEnv({ ...REQUIRED, PORT: '0' })).toThrow(EnvValidationError);
  });

  it('defaults SEARCH_INDEX_HEADER_NAME and leaves SEARCH_INDEX_API_KEY unset', () => {
    const env = loadEnv(REQUIRED);
    expect(env.SEARCH_INDEX_HEADER_NAME).toBe('x-internal-api-key');
    expect(env.SEARCH_INDEX_API_KEY).toBeUndefined();
  });

  it('accepts a well-formed SEARCH_INDEX_API_KEY', () => {
    const env = loadEnv({ ...REQUIRED, SEARCH_INDEX_API_KEY: 's'.repeat(32) });
    expect(env.SEARCH_INDEX_API_KEY).toBe('s'.repeat(32));
  });

  it('rejects a short SEARCH_INDEX_API_KEY', () => {
    expect(() => loadEnv({ ...REQUIRED, SEARCH_INDEX_API_KEY: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('accepts a custom SEARCH_INDEX_HEADER_NAME', () => {
    const env = loadEnv({
      ...REQUIRED,
      SEARCH_INDEX_HEADER_NAME: 'x-search-secret',
    });
    expect(env.SEARCH_INDEX_HEADER_NAME).toBe('x-search-secret');
  });

  it('rejects an empty SEARCH_INDEX_HEADER_NAME', () => {
    expect(() => loadEnv({ ...REQUIRED, SEARCH_INDEX_HEADER_NAME: '' })).toThrow(
      EnvValidationError,
    );
  });
});
