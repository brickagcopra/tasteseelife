import { BadRequestException } from '@nestjs/common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';
import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import { WebhookMetrics } from '../../../observability/webhook-metrics';
import type { StripeIngressService } from '../services/stripe-ingress.service';
import type {
  StripeWebhookVerificationResult,
  StripeWebhookVerifierService,
} from '../services/stripe-webhook-verifier.service';
import { StripeWebhookController } from './stripe-webhook.controller';

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

function buildController(args: {
  readonly verifyResult?: StripeWebhookVerificationResult;
  readonly persistOutcome?: 'persisted' | 'duplicate';
  readonly persistError?: Error;
  readonly store?: TenantContextStore;
}): {
  controller: StripeWebhookController;
  verifierSpy: ReturnType<typeof vi.fn>;
  ingressSpy: ReturnType<typeof vi.fn>;
} {
  const verifierSpy = vi
    .fn()
    .mockReturnValue(args.verifyResult ?? { ok: false, reason: 'missing_signature_header' });
  const ingressSpy = vi.fn().mockImplementation(async () => {
    if (args.persistError) {
      throw args.persistError;
    }
    return args.persistOutcome ?? 'persisted';
  });

  const verifier = { verify: verifierSpy } as unknown as StripeWebhookVerifierService;
  const ingress = { persist: ingressSpy } as unknown as StripeIngressService;

  return {
    controller: new StripeWebhookController(verifier, ingress, args.store ?? makeStore()),
    verifierSpy,
    ingressSpy,
  };
}

function buildRequest(body: unknown): Request {
  return {
    body,
    headers: { 'content-type': 'application/json' },
    url: '/api/v1/webhooks/stripe',
    method: 'POST',
  } as unknown as Request;
}

function makeEvent(overrides: Partial<Stripe.Event> = {}): Stripe.Event {
  return {
    id: 'evt_ctrl_1',
    object: 'event',
    api_version: '2025-09-30.basil',
    created: Math.floor(Date.now() / 1000),
    data: { object: {} } as Stripe.Event.Data,
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: 'customer.subscription.created',
    ...overrides,
  } as Stripe.Event;
}

describe('StripeWebhookController.receive', () => {
  describe('success: first-time event', () => {
    it('returns received=true + outcome=persisted when verification + persist succeed', async () => {
      const event = makeEvent({ id: 'evt_received' });
      const { controller, verifierSpy, ingressSpy } = buildController({
        verifyResult: { ok: true, event, verifiedAt: new Date('2026-05-10T18:00:00.000Z') },
        persistOutcome: 'persisted',
      });

      const result = await controller.receive(
        buildRequest(Buffer.from('{"id":"evt_received"}')),
        't=1,v1=ok',
      );

      expect(result).toEqual({
        received: true,
        eventId: 'evt_received',
        outcome: 'persisted',
      });
      expect(verifierSpy).toHaveBeenCalledTimes(1);
      expect(ingressSpy).toHaveBeenCalledWith({ event, verifiedAt: expect.any(Date) });
    });

    it('passes the raw Buffer body through to the verifier untouched', async () => {
      const body = Buffer.from('{"important":"bytes"}');
      const event = makeEvent();
      const { controller, verifierSpy } = buildController({
        verifyResult: { ok: true, event, verifiedAt: new Date() },
      });

      await controller.receive(buildRequest(body), 't=1,v1=ok');

      const callArg = verifierSpy.mock.calls[0]![0] as {
        rawBody: Buffer;
        signatureHeader: string;
      };
      expect(callArg.rawBody).toBe(body);
      expect(callArg.signatureHeader).toBe('t=1,v1=ok');
    });
  });

  describe('success: duplicate replay', () => {
    it('returns outcome=duplicate when ingress reports an already-persisted event', async () => {
      const event = makeEvent({ id: 'evt_dup' });
      const { controller } = buildController({
        verifyResult: { ok: true, event, verifiedAt: new Date() },
        persistOutcome: 'duplicate',
      });

      const result = await controller.receive(buildRequest(Buffer.from('{}')), 't=1,v1=ok');

      expect(result).toEqual({
        received: true,
        eventId: 'evt_dup',
        outcome: 'duplicate',
      });
    });
  });

  describe('failure: verification rejects', () => {
    it.each([
      'missing_signature_header',
      'invalid_signature',
      'replay_outside_tolerance',
      'invalid_payload_shape',
      'unknown',
    ] as const)(
      'throws 400 (signature failure terse body) when the verifier returns reason=%s',
      async (reason) => {
        const { controller, ingressSpy } = buildController({
          verifyResult: { ok: false, reason },
        });

        const promise = controller.receive(
          buildRequest(Buffer.from('whatever')),
          't=1,v1=tampered',
        );

        await expect(promise).rejects.toBeInstanceOf(BadRequestException);
        // Confirm the response body is the terse generic shape — NOT the
        // verifier's reason. An attacker probing the endpoint learns
        // nothing about which check failed.
        try {
          await promise;
        } catch (err) {
          const body = (err as BadRequestException).getResponse() as Record<string, unknown>;
          expect(body['detail']).toBe('Stripe webhook signature verification failed.');
          expect(JSON.stringify(body)).not.toContain(reason);
        }
        // Ingress is never invoked on a verification failure — defence-in-
        // depth so an unverified payload can never land a DB row.
        expect(ingressSpy).not.toHaveBeenCalled();
      },
    );
  });

  describe('failure: misconfigured raw body parser', () => {
    it('throws 400 when req.body is not a Buffer (parser wiring is broken)', async () => {
      const { controller, verifierSpy, ingressSpy } = buildController({});

      // Object-shaped body — what we'd see if Nest's default JSON parser
      // accidentally ran first instead of the raw parser. Surfaces the
      // misconfiguration loudly rather than handing a re-serialised
      // payload to the verifier (which would fail signature verification
      // for an unrelated reason).
      const promise = controller.receive(
        buildRequest({ id: 'evt_oops' } as unknown as Buffer),
        't=1,v1=ok',
      );

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      // The verifier is NOT consulted — we caught the misconfiguration at
      // the controller boundary.
      expect(verifierSpy).not.toHaveBeenCalled();
      expect(ingressSpy).not.toHaveBeenCalled();
    });
  });

  describe('failure: persist throws (downstream DB error)', () => {
    it('propagates the error so the global filter returns a generic 500', async () => {
      const event = makeEvent();
      const dbErr = new Error('FATAL: connection terminated');
      const { controller } = buildController({
        verifyResult: { ok: true, event, verifiedAt: new Date() },
        persistError: dbErr,
      });

      await expect(controller.receive(buildRequest(Buffer.from('{}')), 't=1,v1=ok')).rejects.toBe(
        dbErr,
      );
    });
  });
});

/**
 * Tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout).
 *
 * `StripeWebhookController.receive` is a Prisma-touching pre-auth surface
 * — Stripe's edge does not log in as a Taste & See user, so the
 * `TenantContextInterceptor` cannot seed a scoped frame from a
 * `request.requestContext` that does not exist. Without an explicit
 * exempt wrap, every Prisma operation downstream of this handler
 * (`StripeIngressService.persist` writes the `stripe_processed_events`
 * row) would hard-fail with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`.
 *
 * These tests pin the wrap contract by constructing the controller with
 * a real `TenantContextStore`, passing a fake collaborator (the
 * `StripeIngressService`) whose `persist` method captures
 * `store.current()` at call time, and asserting:
 *
 *   - the captured frame is `{ kind: 'exempt', reason:
 *     'external-stripe-webhook-receive' }` — the precise grep-able reason
 *     string the audit log will surface so a future log scan can trace
 *     every "no-context" Prisma access back to its inbound source;
 *   - `store.current() === null` BEFORE and AFTER the handler call —
 *     the wrap leaves no frame behind (the `AsyncLocalStorage` `.run`
 *     scoping ensures this);
 *   - the 400 branches ALSO run inside the same wrap (the
 *     `Buffer.isBuffer` check probe + the verifier-failure probe live
 *     INSIDE the wrap so the captured frame is visible).
 *
 * Mirrors the canonical shape in `service-identity`'s
 * `KycController.receiveWebhookEvent` and `service-provider`'s
 * `ApplicationsController.receiveWebhookEvent` under TS-020-followup-2b.
 */
describe('StripeWebhookController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('runs receive inside an exempt frame with reason "external-stripe-webhook-receive"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const event = makeEvent({ id: 'evt_wrap_happy' });
    const verifier = {
      verify: vi.fn().mockReturnValue({ ok: true, event, verifiedAt: new Date() }),
    } as unknown as StripeWebhookVerifierService;
    const ingress = {
      persist: vi.fn(async () => {
        captured = store.current();
        return 'persisted' as const;
      }),
    } as unknown as StripeIngressService;
    const controller = new StripeWebhookController(verifier, ingress, store);

    expect(store.current()).toBeNull();
    await controller.receive(buildRequest(Buffer.from('{}')), 't=1,v1=ok');
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'external-stripe-webhook-receive',
    });
  });

  it('runs the not-a-Buffer 400 branch inside the same exempt frame', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    // The not-a-Buffer short-circuit returns before any verifier/ingress
    // call, so the captured-frame probe lives on the request itself — we
    // wrap `headers` in a getter that captures `store.current()` when the
    // logger's structured-context lookup reaches for `content-type`.
    const probingRequest = {
      body: 'not-a-buffer' as unknown,
      get headers() {
        captured = store.current();
        return { 'content-type': 'application/json' };
      },
      url: '/api/v1/webhooks/stripe',
      method: 'POST',
    } as unknown as Request;
    const verifier = {
      verify: vi.fn(),
    } as unknown as StripeWebhookVerifierService;
    const ingress = {
      persist: vi.fn(),
    } as unknown as StripeIngressService;
    const controller = new StripeWebhookController(verifier, ingress, store);

    expect(store.current()).toBeNull();
    await expect(controller.receive(probingRequest, 't=1,v1=ok')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'external-stripe-webhook-receive',
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
    } as unknown as StripeWebhookVerifierService;
    const ingress = {
      persist: vi.fn(),
    } as unknown as StripeIngressService;
    const controller = new StripeWebhookController(verifier, ingress, store);

    expect(store.current()).toBeNull();
    await expect(
      controller.receive(buildRequest(Buffer.from('{}')), 't=1,v1=tampered'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'external-stripe-webhook-receive',
    });
  });
});

/**
 * Domain-metrics wiring (TS-041a-followup-4).
 *
 * The controller is the single convergence point where the verification
 * result and the persistence outcome are both observable, so it owns the
 * `stripe_webhook_verified_total{result,reason}` +
 * `stripe_webhook_persisted_total{outcome}` counter increments. These
 * tests construct the controller with an explicit `WebhookMetrics`
 * (whose public record methods are spied — the underlying OTel
 * instruments are no-op meters in unit context) and pin that each code
 * path increments the right series with the right labels. WebhookMetrics
 * itself is unit-tested against a booted MeterProvider in
 * `observability/webhook-metrics.test.ts`.
 */
describe('StripeWebhookController domain metrics (TS-041a-followup-4)', () => {
  function buildWithMetrics(args: {
    readonly verifyResult: StripeWebhookVerificationResult;
    readonly persistOutcome?: 'persisted' | 'duplicate';
  }): {
    controller: StripeWebhookController;
    verificationSpy: ReturnType<typeof vi.spyOn>;
    persistedSpy: ReturnType<typeof vi.spyOn>;
  } {
    const verifier = {
      verify: vi.fn().mockReturnValue(args.verifyResult),
    } as unknown as StripeWebhookVerifierService;
    const ingress = {
      persist: vi.fn(async () => args.persistOutcome ?? 'persisted'),
    } as unknown as StripeIngressService;
    const metrics = new WebhookMetrics();
    const verificationSpy = vi.spyOn(metrics, 'recordStripeVerification');
    const persistedSpy = vi.spyOn(metrics, 'recordStripePersisted');
    const controller = new StripeWebhookController(verifier, ingress, makeStore(), metrics);
    return { controller, verificationSpy, persistedSpy };
  }

  it('records result=ok/reason=none + outcome=persisted on the happy path', async () => {
    const event = makeEvent({ id: 'evt_metrics_ok' });
    const { controller, verificationSpy, persistedSpy } = buildWithMetrics({
      verifyResult: { ok: true, event, verifiedAt: new Date() },
      persistOutcome: 'persisted',
    });

    await controller.receive(buildRequest(Buffer.from('{}')), 't=1,v1=ok');

    expect(verificationSpy).toHaveBeenCalledTimes(1);
    expect(verificationSpy).toHaveBeenCalledWith('ok', 'none');
    expect(persistedSpy).toHaveBeenCalledTimes(1);
    expect(persistedSpy).toHaveBeenCalledWith('persisted');
  });

  it('records outcome=duplicate on a replay', async () => {
    const event = makeEvent({ id: 'evt_metrics_dup' });
    const { controller, persistedSpy } = buildWithMetrics({
      verifyResult: { ok: true, event, verifiedAt: new Date() },
      persistOutcome: 'duplicate',
    });

    await controller.receive(buildRequest(Buffer.from('{}')), 't=1,v1=ok');

    expect(persistedSpy).toHaveBeenCalledTimes(1);
    expect(persistedSpy).toHaveBeenCalledWith('duplicate');
  });

  it.each([
    'missing_signature_header',
    'invalid_signature',
    'replay_outside_tolerance',
    'invalid_payload_shape',
    'unknown',
  ] as const)(
    'records result=reject with the verifier reason=%s and never touches the persisted counter',
    async (reason) => {
      const { controller, verificationSpy, persistedSpy } = buildWithMetrics({
        verifyResult: { ok: false, reason },
      });

      await expect(
        controller.receive(buildRequest(Buffer.from('x')), 't=1,v1=bad'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(verificationSpy).toHaveBeenCalledTimes(1);
      expect(verificationSpy).toHaveBeenCalledWith('reject', reason);
      expect(persistedSpy).not.toHaveBeenCalled();
    },
  );

  it('records result=reject/reason=missing_raw_body when the raw-body parser is unwired', async () => {
    const { controller, verificationSpy, persistedSpy } = buildWithMetrics({
      verifyResult: { ok: false, reason: 'unknown' },
    });

    await expect(
      controller.receive(buildRequest({ not: 'a buffer' } as unknown as Buffer), 't=1,v1=ok'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(verificationSpy).toHaveBeenCalledTimes(1);
    expect(verificationSpy).toHaveBeenCalledWith('reject', 'missing_raw_body');
    expect(persistedSpy).not.toHaveBeenCalled();
  });
});
