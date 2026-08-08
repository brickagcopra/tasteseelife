import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import type Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';

import { StripeIdentityKycDispatchService } from './kyc-dispatch.service';

/**
 * Tests for the cross-service KYC dispatcher (TS-026).
 *
 * The dispatcher uses the global `fetch` API; we mock it via
 * `vi.stubGlobal('fetch', ...)` so the network never gets touched.
 * Prisma is stubbed to the single `stripeProcessedEvent.update`
 * shape the dispatcher's `markDispatched` touches.
 */

interface FakePrisma {
  readonly stripeProcessedEvent: {
    readonly update: ReturnType<typeof vi.fn>;
  };
}

const KEY = 'k'.repeat(48);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    KYC_DISPATCH_URL: 'https://service-identity.internal/api/v1/internal/kyc/webhook-events',
    KYC_DISPATCH_API_KEY: KEY,
    KYC_DISPATCH_TIMEOUT_MS: 5_000,
    ...overrides,
  } as unknown as Env;
}

function makePrisma(): FakePrisma {
  return {
    stripeProcessedEvent: {
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

function makeService(env: Env, prisma: FakePrisma): StripeIdentityKycDispatchService {
  return new StripeIdentityKycDispatchService(env, prisma as unknown as PrismaService);
}

function makeEvent(overrides: Partial<Stripe.Event> = {}): Stripe.Event {
  return {
    id: 'evt_kyc_1',
    object: 'event',
    api_version: '2024-06-20',
    created: 1_700_000_000,
    data: {
      object: {
        id: 'vs_abc',
        object: 'identity.verification_session',
        status: 'verified',
        client_secret: null,
        url: null,
      } as unknown as Stripe.Identity.VerificationSession,
    } as Stripe.Event.Data,
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: 'identity.verification_session.verified',
    ...overrides,
  } as Stripe.Event;
}

describe('StripeIdentityKycDispatchService.isDispatchable', () => {
  it('returns true for identity.verification_session.* event types', () => {
    expect(
      StripeIdentityKycDispatchService.isDispatchable('identity.verification_session.verified'),
    ).toBe(true);
    expect(
      StripeIdentityKycDispatchService.isDispatchable('identity.verification_session.processing'),
    ).toBe(true);
    expect(
      StripeIdentityKycDispatchService.isDispatchable('identity.verification_session.canceled'),
    ).toBe(true);
  });

  it('returns false for non-identity event types', () => {
    expect(StripeIdentityKycDispatchService.isDispatchable('customer.subscription.created')).toBe(
      false,
    );
    expect(StripeIdentityKycDispatchService.isDispatchable('invoice.paid')).toBe(false);
  });
});

describe('StripeIdentityKycDispatchService.dispatch', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null (no-op) when KYC_DISPATCH_URL is unset', async () => {
    const env = makeEnv({ KYC_DISPATCH_URL: undefined, KYC_DISPATCH_API_KEY: undefined });
    const service = makeService(env, makePrisma());
    const outcome = await service.dispatch(makeEvent());
    expect(outcome).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to service-identity with shared-secret header and parses the outcome', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'applied', record: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const service = makeService(makeEnv(), makePrisma());
    const outcome = await service.dispatch(makeEvent());
    expect(outcome).toBe('applied');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://service-identity.internal/api/v1/internal/kyc/webhook-events');
    const headers = options.headers as Record<string, string>;
    expect(headers['x-kyc-internal-api-key']).toBe(KEY);
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(options.body as string) as { eventId: string; eventType: string };
    expect(body.eventId).toBe('evt_kyc_1');
    expect(body.eventType).toBe('identity.verification_session.verified');
  });

  it('propagates `replayed` and `session_mismatch` outcome strings', async () => {
    for (const outcome of ['replayed', 'session_mismatch'] as const) {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ outcome, record: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const service = makeService(makeEnv(), makePrisma());
      expect(await service.dispatch(makeEvent())).toBe(outcome);
    }
  });

  it('returns null on non-2xx (do not mark dispatched)', async () => {
    fetchSpy.mockResolvedValue(new Response('upstream down', { status: 503 }));
    const service = makeService(makeEnv(), makePrisma());
    expect(await service.dispatch(makeEvent())).toBeNull();
  });

  it('returns null on fetch throw (network failure / abort)', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const service = makeService(makeEnv(), makePrisma());
    expect(await service.dispatch(makeEvent())).toBeNull();
  });

  it('returns null when service-identity returns an unknown outcome string', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'maybe', record: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const service = makeService(makeEnv(), makePrisma());
    expect(await service.dispatch(makeEvent())).toBeNull();
  });

  it('returns null when service-identity returns non-JSON body', async () => {
    fetchSpy.mockResolvedValue(new Response('not json', { status: 200 }));
    const service = makeService(makeEnv(), makePrisma());
    expect(await service.dispatch(makeEvent())).toBeNull();
  });
});

/**
 * Observability metrics (TS-026-followup-7; CLAUDE.md §10). Init a real
 * MeterProvider, drive `dispatch` through each branch, then assert the
 * Prometheus text exposition. `makeService()` is called inside each test
 * (after `initMetrics`) so the default `WebhookMetrics` instance binds its
 * instruments to the live meter rather than the no-op fallback.
 */
describe('StripeIdentityKycDispatchService.dispatch — observability metrics', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    initMetrics({
      service: 'service-webhook-test',
      env: 'test',
      exportIntervalMillis: 3_600_000,
    });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await shutdownMetrics();
  });

  it('counts a no-op dispatch with outcome="skipped" and emits no latency sample', async () => {
    const env = makeEnv({ KYC_DISPATCH_URL: undefined, KYC_DISPATCH_API_KEY: undefined });
    const service = makeService(env, makePrisma());
    await service.dispatch(makeEvent());

    const out = await serializeMetrics();
    expect(out).toMatch(/kyc_dispatch_total\{[^}]*outcome="skipped"[^}]*\} 1/);
    // The skipped path makes no HTTP request, so no latency bucket lands.
    expect(out).not.toMatch(/kyc_dispatch_duration_seconds_count\{[^}]*outcome="skipped"/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('counts an applied dispatch with outcome="applied" + a latency sample', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'applied', record: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const service = makeService(makeEnv(), makePrisma());
    await service.dispatch(makeEvent());

    const out = await serializeMetrics();
    expect(out).toMatch(/kyc_dispatch_total\{[^}]*outcome="applied"[^}]*\} 1/);
    expect(out).toMatch(/kyc_dispatch_duration_seconds_count\{[^}]*outcome="applied"[^}]*\} 1/);
  });

  it('counts a non-2xx response with outcome="http_error"', async () => {
    fetchSpy.mockResolvedValue(new Response('upstream down', { status: 503 }));
    const service = makeService(makeEnv(), makePrisma());
    await service.dispatch(makeEvent());

    const out = await serializeMetrics();
    expect(out).toMatch(/kyc_dispatch_total\{[^}]*outcome="http_error"[^}]*\} 1/);
  });

  it('counts a fetch throw with outcome="network_error"', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const service = makeService(makeEnv(), makePrisma());
    await service.dispatch(makeEvent());

    const out = await serializeMetrics();
    expect(out).toMatch(/kyc_dispatch_total\{[^}]*outcome="network_error"[^}]*\} 1/);
  });

  it('counts an unknown / unparseable response with outcome="bad_response"', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'maybe' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const service = makeService(makeEnv(), makePrisma());
    await service.dispatch(makeEvent());

    const out = await serializeMetrics();
    expect(out).toMatch(/kyc_dispatch_total\{[^}]*outcome="bad_response"[^}]*\} 1/);
  });

  it('never leaks the event id / session id onto the scrape surface', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'applied', record: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const service = makeService(makeEnv(), makePrisma());
    await service.dispatch(makeEvent());

    const out = await serializeMetrics();
    expect(out).not.toContain('evt_kyc_1');
    expect(out).not.toContain('vs_abc');
    expect(out).toMatch(/kyc_dispatch_total/);
  });
});

describe('StripeIdentityKycDispatchService.markDispatched', () => {
  it('calls prisma.stripeProcessedEvent.update with eventId + dispatchedAt: <now>', async () => {
    const prisma = makePrisma();
    const service = makeService(makeEnv(), prisma);
    await service.markDispatched('evt_marker');
    expect(prisma.stripeProcessedEvent.update).toHaveBeenCalledTimes(1);
    const call = prisma.stripeProcessedEvent.update.mock.calls[0]![0] as {
      where: { eventId: string };
      data: { dispatchedAt: Date };
    };
    expect(call.where.eventId).toBe('evt_marker');
    expect(call.data.dispatchedAt).toBeInstanceOf(Date);
  });

  it('swallows DB errors so the controller can still ack Stripe', async () => {
    const prisma: FakePrisma = {
      stripeProcessedEvent: {
        update: vi.fn().mockRejectedValue(new Error('DB unavailable')),
      },
    };
    const service = makeService(makeEnv(), prisma);
    await expect(service.markDispatched('evt_x')).resolves.toBeUndefined();
  });
});
