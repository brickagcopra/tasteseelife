import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../config/env';
import { AggregationClient } from './aggregation.client';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3054,
    LOG_LEVEL: 'info',
    SERVICE_VERSION: 'test',
    // Required on `Env` because `.default(true)` makes the OUTPUT type
    // required even though the input is optional (TS-504-followup-2a-2).
    OTEL_TRACES_ENABLED: true,
    OTEL_METRICS_ENABLED: true,
    ANALYTICS_SERVICE_BASE_URL: 'http://service-analytics:3023',
    ANALYTICS_AGGREGATION_INTERNAL_API_KEY: 'k'.repeat(32),
    ANALYTICS_AGGREGATION_INTERNAL_HEADER_NAME: 'x-analytics-internal-api-key',
    REQUEST_TIMEOUT_MS: 30_000,
    ANALYTICS_AGGREGATOR_ENABLED: true,
    ANALYTICS_AGGREGATOR_RUN_HOUR_UTC: 3,
    ANALYTICS_AGGREGATOR_SCHEDULER_TICK_MS: 3_600_000,
    ...overrides,
  };
}

const okResponse = {
  metricDate: '2026-06-08',
  totalSearches: 120,
  zeroResultSearches: 18,
  distinctSearchers: 40,
  bookingsCreated: 6,
  attributedBookings: 4,
  topQueryCount: 55,
  sortBucketCount: 3,
  zeroResultRatePpm: 150_000,
  approxConversionPpm: 150_000,
  attributedConversionPpm: 33_333,
  runId: 'run_test_1',
  computedAt: '2026-06-09T03:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AggregationClient.compute', () => {
  it('POSTs to the compute endpoint with the shared secret, asOf, and idempotency key', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify(okResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AggregationClient(buildEnv());
    const result = await client.compute(
      '2026-06-08T00:00:00.000Z',
      'search-relevance:compute:2026-06-08',
    );

    expect(result.metricDate).toBe('2026-06-08');
    expect(result.totalSearches).toBe(120);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://service-analytics:3023/api/v1/internal/analytics/search-relevance/compute',
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-analytics-internal-api-key']).toBe('k'.repeat(32));
    expect(headers['idempotency-key']).toBe('search-relevance:compute:2026-06-08');
    expect(init.body).toBe('{"asOf":"2026-06-08T00:00:00.000Z"}');
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    );
    const client = new AggregationClient(buildEnv());
    await expect(client.compute('2026-06-08T00:00:00.000Z', 'key')).rejects.toThrow(
      /service-analytics/,
    );
  });

  it('throws on a contract-violating response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ metricDate: 'nope', totalSearches: -1 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const client = new AggregationClient(buildEnv());
    await expect(client.compute('2026-06-08T00:00:00.000Z', 'key')).rejects.toThrow(/schema/);
  });

  it('trims a trailing slash from the base URL', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify(okResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AggregationClient(
      buildEnv({ ANALYTICS_SERVICE_BASE_URL: 'http://service-analytics:3023/' }),
    );
    await client.compute('2026-06-08T00:00:00.000Z', 'key');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://service-analytics:3023/api/v1/internal/analytics/search-relevance/compute',
    );
  });
});
