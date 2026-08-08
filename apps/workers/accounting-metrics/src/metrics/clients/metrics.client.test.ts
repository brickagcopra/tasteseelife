import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../config/env';
import { MetricsClient } from './metrics.client';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3053,
    LOG_LEVEL: 'info',
    SERVICE_VERSION: 'test',
    // Required on `Env` because `.default(true)` makes the OUTPUT type
    // required even though the input is optional (TS-504-followup-2a-2).
    OTEL_TRACES_ENABLED: true,
    OTEL_METRICS_ENABLED: true,
    ACCOUNTING_SERVICE_BASE_URL: 'http://service-accounting:3015',
    ACCOUNTING_SAAS_METRICS_INTERNAL_API_KEY: 'k'.repeat(32),
    ACCOUNTING_SAAS_METRICS_INTERNAL_HEADER_NAME: 'x-accounting-internal-api-key',
    REQUEST_TIMEOUT_MS: 30_000,
    ACCOUNTING_METRICS_ENABLED: true,
    ACCOUNTING_METRICS_RUN_HOUR_UTC: 2,
    ACCOUNTING_METRICS_SCHEDULER_TICK_MS: 3_600_000,
    ...overrides,
  };
}

const okResponse = {
  metrics: {
    metricDate: '2026-05-28',
    currency: 'USD',
    mrrMinor: 22_800,
    arrMinor: 273_600,
    arpuMinor: 11_400,
    activeSubscriptions: 2,
    newMrrMinor: 22_800,
    expansionMrrMinor: 0,
    contractionMrrMinor: 0,
    churnedMrrMinor: 0,
    churnedSubscriptions: 0,
    netNewMrrMinor: 22_800,
    priorMrrMinor: 0,
    netRevenueRetentionPpm: null,
    grossRevenueRetentionPpm: null,
    ltvMinor: null,
    cacMinor: null,
    comparisonDate: null,
    computedAt: '2026-05-28T02:00:00.000Z',
  },
  subscriptionsSnapshotted: 2,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MetricsClient.compute', () => {
  it('POSTs to the compute endpoint with the shared secret + idempotency key', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify(okResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new MetricsClient(buildEnv());
    const result = await client.compute('saas-metrics:compute:2026-05-28');

    expect(result.metrics.metricDate).toBe('2026-05-28');
    expect(result.subscriptionsSnapshotted).toBe(2);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://service-accounting:3015/api/v1/internal/accounting/saas-metrics/compute',
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-accounting-internal-api-key']).toBe('k'.repeat(32));
    expect(headers['idempotency-key']).toBe('saas-metrics:compute:2026-05-28');
    expect(init.body).toBe('{}');
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    );
    const client = new MetricsClient(buildEnv());
    await expect(client.compute('key')).rejects.toThrow(/service-accounting/);
  });

  it('throws on a contract-violating response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ metrics: { mrrMinor: -1 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const client = new MetricsClient(buildEnv());
    await expect(client.compute('key')).rejects.toThrow(/schema/);
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

    const client = new MetricsClient(
      buildEnv({ ACCOUNTING_SERVICE_BASE_URL: 'http://service-accounting:3015/' }),
    );
    await client.compute('key');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://service-accounting:3015/api/v1/internal/accounting/saas-metrics/compute',
    );
  });
});
