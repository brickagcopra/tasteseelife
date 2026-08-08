import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

describe('loadEnv (worker-search-indexer)', () => {
  const baseEnv = {
    REDIS_URL: 'redis://localhost:6379',
    PROVIDER_SERVICE_BASE_URL: 'http://service-provider:3014',
    PROVIDER_DISCOVERY_INTERNAL_API_KEY: 'd'.repeat(48),
    SEARCH_SERVICE_BASE_URL: 'http://service-search:3020',
    SEARCH_INDEX_API_KEY: 'k'.repeat(48),
  } as const;

  it('accepts a well-formed env and applies defaults', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.PORT).toBe(3055);
    expect(env.NODE_ENV).toBe('development');
    expect(env.OUTBOX_CONSUMER_GROUP).toBe('worker-search-indexer');
    expect(env.OUTBOX_CONSUMER_NAME).toBe('default');
    expect(env.OUTBOX_STREAM_PREFIX).toBe('events');
    expect(env.OUTBOX_MAX_ATTEMPTS).toBe(10);
    expect(env.OUTBOX_POLL_BLOCK_MS).toBe(5_000);
    expect(env.OUTBOX_RECLAIM_IDLE_MS).toBe(60_000);
    expect(env.OUTBOX_POLL_INTERVAL_MS).toBe(1_000);
    expect(env.PROVIDER_DISCOVERY_INTERNAL_HEADER_NAME).toBe(
      'x-provider-discovery-internal-api-key',
    );
    expect(env.SEARCH_INDEX_HEADER_NAME).toBe('x-internal-api-key');
  });

  it('throws when REDIS_URL is missing', () => {
    const { REDIS_URL: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('rejects a non-URL REDIS_URL', () => {
    expect(() => loadEnv({ ...baseEnv, REDIS_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('rejects a PROVIDER_DISCOVERY_INTERNAL_API_KEY shorter than 32 chars', () => {
    expect(() => loadEnv({ ...baseEnv, PROVIDER_DISCOVERY_INTERNAL_API_KEY: 'short' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a SEARCH_INDEX_API_KEY shorter than 32 chars', () => {
    expect(() => loadEnv({ ...baseEnv, SEARCH_INDEX_API_KEY: 'short' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a non-URL PROVIDER_SERVICE_BASE_URL', () => {
    expect(() => loadEnv({ ...baseEnv, PROVIDER_SERVICE_BASE_URL: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });

  it('clamps PROVIDER_REQUEST_TIMEOUT_MS to [500, 30000]', () => {
    expect(() => loadEnv({ ...baseEnv, PROVIDER_REQUEST_TIMEOUT_MS: '200' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...baseEnv, PROVIDER_REQUEST_TIMEOUT_MS: '60000' })).toThrow(
      EnvValidationError,
    );
    const ok = loadEnv({ ...baseEnv, PROVIDER_REQUEST_TIMEOUT_MS: '10000' });
    expect(ok.PROVIDER_REQUEST_TIMEOUT_MS).toBe(10_000);
  });
});
