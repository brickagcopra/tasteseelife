import { createHmac } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import { WebhookMetrics } from '../../../observability/webhook-metrics';
import { CHECKR_SIGNATURE_HEADER } from '../checkr.constants';
import { CheckrIngressService } from '../services/checkr-ingress.service';
import { CheckrWebhookVerifierService } from '../services/checkr-webhook-verifier.service';

import { CheckrWebhookController } from './checkr-webhook.controller';

const SECRET = 'whsec_test_checkr_bbbbbbbbbbbbbb';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CHECKR_WEBHOOK_SECRET: SECRET,
    CHECKR_WEBHOOK_TOLERANCE_SECONDS: 300,
    ...overrides,
  } as unknown as Env;
}

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

function signedHeaderFor(rawBody: Buffer, timestampSeconds: number): string {
  const v1 = createHmac('sha256', SECRET)
    .update(`${timestampSeconds}.${rawBody.toString('utf8')}`, 'utf8')
    .digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

function makeBody(): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: 'evt_abc',
      type: 'report.completed',
      account_id: 'acc_xyz',
      created_at: '2026-05-11T12:00:00Z',
      data: {
        object: { id: 'rep_abc', status: 'clear', candidate_id: 'cand_abc' },
      },
    }),
    'utf8',
  );
}

function makeController(args: {
  readonly persistOutcome?: 'persisted' | 'duplicate';
  readonly store?: TenantContextStore;
}): CheckrWebhookController {
  const verifier = new CheckrWebhookVerifierService(makeEnv());
  const persist = vi.fn().mockResolvedValue(args.persistOutcome ?? 'persisted');
  const ingress = { persist } as unknown as CheckrIngressService;
  return new CheckrWebhookController(verifier, ingress, args.store ?? makeStore());
}

describe('CheckrWebhookController.receive', () => {
  it('returns received=true with outcome=persisted on the happy path', async () => {
    const controller = makeController({ persistOutcome: 'persisted' });
    const body = makeBody();
    const ts = Math.floor(Date.now() / 1000);
    const response = await controller.receive(
      { body, headers: { 'content-type': 'application/json' } } as never,
      signedHeaderFor(body, ts),
    );
    expect(response.received).toBe(true);
    expect(response.eventId).toBe('evt_abc');
    expect(response.outcome).toBe('persisted');
  });

  it('returns outcome=duplicate when the ingress reports a duplicate', async () => {
    const controller = makeController({ persistOutcome: 'duplicate' });
    const body = makeBody();
    const ts = Math.floor(Date.now() / 1000);
    const response = await controller.receive(
      { body, headers: { 'content-type': 'application/json' } } as never,
      signedHeaderFor(body, ts),
    );
    expect(response.outcome).toBe('duplicate');
  });

  it('throws 400 when the body is not a Buffer (raw-body parser misconfigured)', async () => {
    const controller = makeController({});
    await expect(
      controller.receive({ body: 'not-a-buffer', headers: {} } as never, 't=1,v1=abc'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws 400 when signature verification fails', async () => {
    const controller = makeController({});
    const body = makeBody();
    await expect(
      controller.receive(
        { body, headers: { 'content-type': 'application/json' } } as never,
        't=1,v1=' + 'a'.repeat(64),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws 400 when the signature header is missing', async () => {
    const controller = makeController({});
    const body = makeBody();
    await expect(
      controller.receive(
        { body, headers: { 'content-type': 'application/json' } } as never,
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses the configured signature header name', () => {
    // Pin the constant — the controller's `@Headers(...)` binding
    // must match what main.ts and the dashboard expect.
    expect(CHECKR_SIGNATURE_HEADER).toBe('x-checkr-signature');
  });
});

/**
 * Tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout).
 *
 * `CheckrWebhookController.receive` is a Prisma-touching pre-auth surface
 * — Checkr's edge does not log in as a Taste & See user, so the
 * `TenantContextInterceptor` cannot seed a scoped frame. Without an
 * explicit exempt wrap, every Prisma operation downstream of this
 * handler (`CheckrIngressService.persist` writes the
 * `checkr_processed_events` row) would hard-fail with
 * `MissingRequestContextError` under the `enforcement: 'enforce'`
 * posture wired in `AppModule`.
 *
 * Mirrors the canonical shape pinned for `StripeWebhookController` in
 * its sibling test file.
 */
describe('CheckrWebhookController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('runs receive inside an exempt frame with reason "external-checkr-webhook-receive"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const verifier = new CheckrWebhookVerifierService(makeEnv());
    const ingress = {
      persist: vi.fn(async () => {
        captured = store.current();
        return 'persisted' as const;
      }),
    } as unknown as CheckrIngressService;
    const controller = new CheckrWebhookController(verifier, ingress, store);
    const body = makeBody();
    const ts = Math.floor(Date.now() / 1000);

    expect(store.current()).toBeNull();
    await controller.receive(
      { body, headers: { 'content-type': 'application/json' } } as never,
      signedHeaderFor(body, ts),
    );
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'external-checkr-webhook-receive',
    });
  });

  it('runs the not-a-Buffer 400 branch inside the same exempt frame', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    // The not-a-Buffer short-circuit returns before any verifier/ingress
    // call, so the captured-frame probe lives on the request itself —
    // wrap `headers` in a getter that captures `store.current()` when the
    // logger's structured-context lookup reaches for `content-type`.
    const probingRequest = {
      body: 'not-a-buffer' as unknown,
      get headers() {
        captured = store.current();
        return {};
      },
    } as never;
    const verifier = new CheckrWebhookVerifierService(makeEnv());
    const ingress = {
      persist: vi.fn(),
    } as unknown as CheckrIngressService;
    const controller = new CheckrWebhookController(verifier, ingress, store);

    expect(store.current()).toBeNull();
    await expect(controller.receive(probingRequest, 't=1,v1=abc')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'external-checkr-webhook-receive',
    });
  });

  it('runs the signature-failure 400 branch inside the same exempt frame', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const verifier = {
      verify: vi.fn().mockImplementation(() => {
        captured = store.current();
        return { ok: false, reason: 'invalid_signature' } as const;
      }),
    } as unknown as CheckrWebhookVerifierService;
    const ingress = {
      persist: vi.fn(),
    } as unknown as CheckrIngressService;
    const controller = new CheckrWebhookController(verifier, ingress, store);
    const body = makeBody();

    expect(store.current()).toBeNull();
    await expect(
      controller.receive(
        { body, headers: { 'content-type': 'application/json' } } as never,
        't=1,v1=' + 'a'.repeat(64),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'external-checkr-webhook-receive',
    });
  });
});

/**
 * Domain-metrics wiring (TS-041a-followup-4). Mirrors the Stripe
 * controller's metrics block: the controller owns the
 * `checkr_webhook_verified_total{result,reason}` +
 * `checkr_webhook_persisted_total{outcome}` increments at the single
 * point where the verification result and persistence outcome converge.
 * WebhookMetrics is unit-tested against a booted MeterProvider in
 * `observability/webhook-metrics.test.ts`; here the record methods are
 * spied to pin the controller's call sites + labels.
 */
describe('CheckrWebhookController domain metrics (TS-041a-followup-4)', () => {
  function buildWithMetrics(args: { readonly persistOutcome?: 'persisted' | 'duplicate' }): {
    controller: CheckrWebhookController;
    verificationSpy: ReturnType<typeof vi.spyOn>;
    persistedSpy: ReturnType<typeof vi.spyOn>;
  } {
    const verifier = new CheckrWebhookVerifierService(makeEnv());
    const ingress = {
      persist: vi.fn().mockResolvedValue(args.persistOutcome ?? 'persisted'),
    } as unknown as CheckrIngressService;
    const metrics = new WebhookMetrics();
    const verificationSpy = vi.spyOn(metrics, 'recordCheckrVerification');
    const persistedSpy = vi.spyOn(metrics, 'recordCheckrPersisted');
    const controller = new CheckrWebhookController(verifier, ingress, makeStore(), metrics);
    return { controller, verificationSpy, persistedSpy };
  }

  it('records result=ok/reason=none + outcome=persisted on the happy path', async () => {
    const { controller, verificationSpy, persistedSpy } = buildWithMetrics({
      persistOutcome: 'persisted',
    });
    const body = makeBody();
    const ts = Math.floor(Date.now() / 1000);

    await controller.receive(
      { body, headers: { 'content-type': 'application/json' } } as never,
      signedHeaderFor(body, ts),
    );

    expect(verificationSpy).toHaveBeenCalledTimes(1);
    expect(verificationSpy).toHaveBeenCalledWith('ok', 'none');
    expect(persistedSpy).toHaveBeenCalledTimes(1);
    expect(persistedSpy).toHaveBeenCalledWith('persisted');
  });

  it('records outcome=duplicate on a replay', async () => {
    const { controller, persistedSpy } = buildWithMetrics({ persistOutcome: 'duplicate' });
    const body = makeBody();
    const ts = Math.floor(Date.now() / 1000);

    await controller.receive(
      { body, headers: { 'content-type': 'application/json' } } as never,
      signedHeaderFor(body, ts),
    );

    expect(persistedSpy).toHaveBeenCalledTimes(1);
    expect(persistedSpy).toHaveBeenCalledWith('duplicate');
  });

  it('records result=reject with a verifier reason on a bad signature; never persists', async () => {
    const { controller, verificationSpy, persistedSpy } = buildWithMetrics({});
    const body = makeBody();

    await expect(
      controller.receive(
        { body, headers: { 'content-type': 'application/json' } } as never,
        't=1,v1=' + 'a'.repeat(64),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(verificationSpy).toHaveBeenCalledTimes(1);
    expect(verificationSpy.mock.calls[0]![0]).toBe('reject');
    // The reason is whatever the real verifier classified — the point is
    // it is a precise, bounded reason string, not the sentinel 'none'.
    expect(verificationSpy.mock.calls[0]![1]).not.toBe('none');
    expect(persistedSpy).not.toHaveBeenCalled();
  });

  it('records result=reject/reason=missing_raw_body when the raw-body parser is unwired', async () => {
    const { controller, verificationSpy, persistedSpy } = buildWithMetrics({});

    await expect(
      controller.receive({ body: 'not-a-buffer', headers: {} } as never, 't=1,v1=abc'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(verificationSpy).toHaveBeenCalledTimes(1);
    expect(verificationSpy).toHaveBeenCalledWith('reject', 'missing_raw_body');
    expect(persistedSpy).not.toHaveBeenCalled();
  });
});
