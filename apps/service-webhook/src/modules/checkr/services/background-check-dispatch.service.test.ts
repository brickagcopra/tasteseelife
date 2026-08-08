import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import { WebhookMetrics } from '../../../observability/webhook-metrics';
import type { PrismaService } from '../../../prisma/prisma.service';

import { BackgroundCheckDispatchService } from './background-check-dispatch.service';
import type { CheckrEventEnvelope } from './checkr-webhook-verifier.service';

const KEY = 'b'.repeat(48);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    BACKGROUND_CHECK_DISPATCH_URL:
      'https://service-provider.internal/api/v1/internal/providers/background-check-events',
    BACKGROUND_CHECK_DISPATCH_API_KEY: KEY,
    BACKGROUND_CHECK_DISPATCH_TIMEOUT_MS: 5_000,
    ...overrides,
  } as unknown as Env;
}

interface FakePrisma {
  readonly checkrProcessedEvent: {
    readonly update: ReturnType<typeof vi.fn>;
  };
}

function makePrisma(): FakePrisma {
  return {
    checkrProcessedEvent: {
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

function makeService(env: Env, prisma: FakePrisma): BackgroundCheckDispatchService {
  return new BackgroundCheckDispatchService(env, prisma as unknown as PrismaService);
}

function makeEnvelope(overrides: Partial<CheckrEventEnvelope> = {}): CheckrEventEnvelope {
  return {
    id: 'evt_abc',
    type: 'report.completed',
    accountId: 'acc_xyz',
    object: {
      id: 'rep_abc',
      kind: 'report',
      status: 'clear',
      candidateId: 'cand_abc',
    },
    createdSeconds: 1_700_000_000,
    ...overrides,
  };
}

function makeFetchResponse(args: { readonly status: number; readonly body: unknown }): Response {
  return {
    ok: args.status >= 200 && args.status < 300,
    status: args.status,
    json: async () => args.body,
  } as unknown as Response;
}

describe('BackgroundCheckDispatchService.isDispatchable', () => {
  it('returns true for `report.*` event types', () => {
    expect(BackgroundCheckDispatchService.isDispatchable('report.completed')).toBe(true);
    expect(BackgroundCheckDispatchService.isDispatchable('report.canceled')).toBe(true);
  });

  it('returns false for non-`report.*` event types', () => {
    expect(BackgroundCheckDispatchService.isDispatchable('candidate.created')).toBe(false);
    expect(BackgroundCheckDispatchService.isDispatchable('invoice.payment_succeeded')).toBe(false);
  });
});

describe('BackgroundCheckDispatchService.dispatch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when BACKGROUND_CHECK_DISPATCH_URL is unset', async () => {
    const service = makeService(
      {
        BACKGROUND_CHECK_DISPATCH_URL: undefined,
        BACKGROUND_CHECK_DISPATCH_API_KEY: undefined,
        BACKGROUND_CHECK_DISPATCH_TIMEOUT_MS: 5_000,
      } as unknown as Env,
      makePrisma(),
    );
    const outcome = await service.dispatch(makeEnvelope(), {});
    expect(outcome).toBeNull();
  });

  it('POSTs to the dispatch URL with the shared-secret header on the happy path', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(makeFetchResponse({ status: 200, body: { outcome: 'applied' } }));

    const service = makeService(makeEnv(), makePrisma());
    const outcome = await service.dispatch(makeEnvelope(), { id: 'evt_abc' });
    expect(outcome).toBe('applied');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://service-provider.internal/api/v1/internal/providers/background-check-events',
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-background-check-internal-api-key']).toBe(KEY);
  });

  it('returns null when the event is missing candidate_id', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const service = makeService(makeEnv(), makePrisma());
    const outcome = await service.dispatch(
      makeEnvelope({
        object: { id: 'rep_abc', kind: 'report', status: 'clear', candidateId: null },
      }),
      {},
    );
    expect(outcome).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when the event is missing status', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const service = makeService(makeEnv(), makePrisma());
    const outcome = await service.dispatch(
      makeEnvelope({
        object: { id: 'rep_abc', kind: 'report', status: null, candidateId: 'cand_abc' },
      }),
      {},
    );
    expect(outcome).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates `replayed` outcome from service-provider', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(makeFetchResponse({ status: 200, body: { outcome: 'replayed' } }));

    const service = makeService(makeEnv(), makePrisma());
    const outcome = await service.dispatch(makeEnvelope(), {});
    expect(outcome).toBe('replayed');
  });

  it('propagates `report_mismatch` outcome from service-provider', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      makeFetchResponse({ status: 200, body: { outcome: 'report_mismatch' } }),
    );

    const service = makeService(makeEnv(), makePrisma());
    const outcome = await service.dispatch(makeEnvelope(), {});
    expect(outcome).toBe('report_mismatch');
  });

  it('returns null on a non-2xx response from service-provider', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(makeFetchResponse({ status: 500, body: {} }));

    const service = makeService(makeEnv(), makePrisma());
    const outcome = await service.dispatch(makeEnvelope(), {});
    expect(outcome).toBeNull();
  });

  it('returns null on a fetch network error', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const service = makeService(makeEnv(), makePrisma());
    const outcome = await service.dispatch(makeEnvelope(), {});
    expect(outcome).toBeNull();
  });

  it('returns null when the service-provider response has an unknown outcome string', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(makeFetchResponse({ status: 200, body: { outcome: 'weird' } }));

    const service = makeService(makeEnv(), makePrisma());
    const outcome = await service.dispatch(makeEnvelope(), {});
    expect(outcome).toBeNull();
  });
});

describe('BackgroundCheckDispatchService.markDispatched', () => {
  it('calls prisma to stamp dispatched_at', async () => {
    const prisma = makePrisma();
    const service = makeService(makeEnv(), prisma);
    await service.markDispatched('evt_abc');
    expect(prisma.checkrProcessedEvent.update).toHaveBeenCalledTimes(1);
    const args = prisma.checkrProcessedEvent.update.mock.calls[0]?.[0] as {
      where: { eventId: string };
      data: Record<string, unknown>;
    };
    expect(args.where.eventId).toBe('evt_abc');
    expect(args.data['dispatchedAt']).toBeInstanceOf(Date);
  });

  it('swallows DB errors so the caller can still ack', async () => {
    const prisma = makePrisma();
    prisma.checkrProcessedEvent.update.mockRejectedValueOnce(new Error('db down'));
    const service = makeService(makeEnv(), prisma);
    // Should not throw.
    await service.markDispatched('evt_abc');
  });
});

/**
 * Dispatch observability (TS-051-followup-7). A real MeterProvider is booted
 * so the `WebhookMetrics` passed here binds live; each branch drives one
 * `checkr_dispatch_total{outcome}` series. Mirrors the kyc-dispatch wiring.
 */
describe('BackgroundCheckDispatchService.dispatch — observability', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    initMetrics({ service: 'service-webhook-test', env: 'test', exportIntervalMillis: 3_600_000 });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await shutdownMetrics();
  });

  function makeMeteredService(env: Env): BackgroundCheckDispatchService {
    return new BackgroundCheckDispatchService(
      env,
      makePrisma() as unknown as PrismaService,
      new WebhookMetrics(),
    );
  }

  it('counts outcome="applied" with a latency sample on the happy path', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(makeFetchResponse({ status: 200, body: { outcome: 'applied' } }));
    await makeMeteredService(makeEnv()).dispatch(makeEnvelope(), {});

    const out = await serializeMetrics();
    expect(out).toMatch(/checkr_dispatch_total\{[^}]*outcome="applied"[^}]*\} 1/);
    expect(out).toMatch(/checkr_dispatch_duration_seconds_count\{[^}]*outcome="applied"[^}]*\} 1/);
  });

  it('counts outcome="skipped" when the dispatch URL is unset (no latency sample)', async () => {
    const env = {
      BACKGROUND_CHECK_DISPATCH_URL: undefined,
      BACKGROUND_CHECK_DISPATCH_API_KEY: undefined,
      BACKGROUND_CHECK_DISPATCH_TIMEOUT_MS: 5_000,
    } as unknown as Env;
    await makeMeteredService(env).dispatch(makeEnvelope(), {});

    const out = await serializeMetrics();
    expect(out).toMatch(/checkr_dispatch_total\{[^}]*outcome="skipped"[^}]*\} 1/);
    expect(out).not.toMatch(
      /checkr_dispatch_duration_seconds_count\{[^}]*outcome="skipped"[^}]*\}/,
    );
  });

  it('counts outcome="http_error" on a non-2xx response', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(makeFetchResponse({ status: 500, body: {} }));
    await makeMeteredService(makeEnv()).dispatch(makeEnvelope(), {});

    const out = await serializeMetrics();
    expect(out).toMatch(/checkr_dispatch_total\{[^}]*outcome="http_error"[^}]*\} 1/);
  });

  it('counts outcome="bad_response" on an unknown outcome string', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(makeFetchResponse({ status: 200, body: { outcome: 'weird' } }));
    await makeMeteredService(makeEnv()).dispatch(makeEnvelope(), {});

    const out = await serializeMetrics();
    expect(out).toMatch(/checkr_dispatch_total\{[^}]*outcome="bad_response"[^}]*\} 1/);
  });
});
