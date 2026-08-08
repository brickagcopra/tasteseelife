import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../config/env';
import { ReconciliationClient } from './reconciliation.client';

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
    ACCOUNTING_SERVICE_BASE_URL: 'http://service-accounting:3015',
    STRIPE_RECONCILIATION_INTERNAL_API_KEY: 'k'.repeat(32),
    STRIPE_RECONCILIATION_INTERNAL_HEADER_NAME: 'x-accounting-internal-api-key',
    REQUEST_TIMEOUT_MS: 30_000,
    STRIPE_RECONCILIATION_ENABLED: true,
    STRIPE_RECONCILIATION_RUN_HOUR_UTC: 3,
    STRIPE_RECONCILIATION_SCHEDULER_TICK_MS: 3_600_000,
    ...overrides,
  };
}

const okResponse = {
  reconciliationDate: '2026-05-28',
  mode: 'live',
  checks: [
    {
      reconciliationDate: '2026-05-28',
      category: 'balance',
      status: 'matched',
      mode: 'live',
      currency: 'USD',
      expectedAmountMinor: 100_000,
      actualAmountMinor: 100_000,
      deltaAmountMinor: 0,
      toleranceAmountMinor: 0,
      stripeTransactionCount: null,
      windowStart: '2026-05-28T00:00:00.000Z',
      windowEnd: '2026-05-29T00:00:00.000Z',
      detail: 'matched',
      computedAt: '2026-05-29T03:00:00.000Z',
      resolvedAt: null,
      resolvedByUserId: null,
      resolutionNotes: null,
    },
  ],
  openMismatchCount: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReconciliationClient.run', () => {
  it('POSTs to the run endpoint with the shared secret + idempotency key', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify(okResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ReconciliationClient(buildEnv());
    const result = await client.run('stripe-reconciliation:run:2026-05-29');

    expect(result.reconciliationDate).toBe('2026-05-28');
    expect(result.openMismatchCount).toBe(0);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://service-accounting:3015/api/v1/internal/accounting/stripe-reconciliation/run',
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-accounting-internal-api-key']).toBe('k'.repeat(32));
    expect(headers['idempotency-key']).toBe('stripe-reconciliation:run:2026-05-29');
    expect(init.body).toBe('{}');
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    );
    const client = new ReconciliationClient(buildEnv());
    await expect(client.run('key')).rejects.toThrow(/service-accounting/);
  });

  it('throws on a contract-violating response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ reconciliationDate: 'bad', mode: 'nope' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const client = new ReconciliationClient(buildEnv());
    await expect(client.run('key')).rejects.toThrow(/schema/);
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

    const client = new ReconciliationClient(
      buildEnv({ ACCOUNTING_SERVICE_BASE_URL: 'http://service-accounting:3015/' }),
    );
    await client.run('key');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://service-accounting:3015/api/v1/internal/accounting/stripe-reconciliation/run',
    );
  });
});
