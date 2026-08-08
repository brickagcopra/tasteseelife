import type { OutboxService } from '@taste-and-see/nest-outbox';
import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import type { WebhookMetrics } from '../../../observability/webhook-metrics';
import type { PrismaService } from '../../../prisma/prisma.service';
import { StripeIdentityKycDispatchService } from './kyc-dispatch.service';
import { StripeIngressService } from './stripe-ingress.service';

/**
 * A minimal `PrismaService` stand-in exposing only the
 * `stripeProcessedEvent.create` shape the ingress touches, plus the
 * `$transaction` the TS-041a-followup-2 relay append needs.
 *
 * The fake runs the callback against the SAME `create` mock and propagates a
 * rejection — so an assertion that the ingress row "rolls back" is expressed
 * here as "the callback threw", which is what an interactive Prisma
 * transaction turns into a rollback. Tests that need the stronger property
 * (a real ROLLBACK) belong in the Testcontainers suite.
 */
interface FakePrisma {
  readonly stripeProcessedEvent: {
    readonly create: ReturnType<typeof vi.fn>;
  };
  readonly $transaction: ReturnType<typeof vi.fn>;
}

interface FakeKycDispatch {
  readonly dispatch: ReturnType<typeof vi.fn>;
  readonly markDispatched: ReturnType<typeof vi.fn>;
}

interface FakeOutbox {
  readonly append: ReturnType<typeof vi.fn>;
}

function buildIngress(args?: {
  readonly create?: ReturnType<typeof vi.fn>;
  readonly kycDispatch?: ReturnType<typeof vi.fn>;
  readonly kycMarkDispatched?: ReturnType<typeof vi.fn>;
  readonly append?: ReturnType<typeof vi.fn>;
}): {
  ingress: StripeIngressService;
  prisma: FakePrisma;
  kyc: FakeKycDispatch;
  outbox: FakeOutbox;
  metrics: { recordStripeRelayAppended: ReturnType<typeof vi.fn> };
} {
  const create = args?.create ?? vi.fn().mockResolvedValue({});
  const prisma: FakePrisma = {
    stripeProcessedEvent: { create },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ stripeProcessedEvent: { create }, $executeRaw: vi.fn() }),
    ),
  };
  const kyc: FakeKycDispatch = {
    dispatch: args?.kycDispatch ?? vi.fn().mockResolvedValue(null),
    markDispatched: args?.kycMarkDispatched ?? vi.fn().mockResolvedValue(undefined),
  };
  const outbox: FakeOutbox = {
    append:
      args?.append ??
      vi.fn().mockResolvedValue({
        kind: 'appended',
        eventId: 'evt_test_abc',
        eventName: 'stripe.subscription.changed',
        occurredAt: new Date(),
      }),
  };
  const metrics = { recordStripeRelayAppended: vi.fn() };
  const ingress = new StripeIngressService(
    prisma as unknown as PrismaService,
    kyc as unknown as StripeIdentityKycDispatchService,
    outbox as unknown as OutboxService,
    metrics as unknown as WebhookMetrics,
  );
  return { ingress, prisma, kyc, outbox, metrics };
}

/**
 * `type` and `data` are widened off `Partial<Stripe.Event>` deliberately.
 * `Stripe.Event` is a discriminated union over ~250 `type` literals, so
 * naming a `type` in the same object literal narrows `data` to that one
 * event's fully-populated object — and these tests want a two-field stub, not
 * a 74-field `Invoice`. Every other field keeps its real type.
 */
function makeEvent(
  overrides: Partial<Omit<Stripe.Event, 'type' | 'data'>> & {
    readonly type?: string;
    readonly data?: unknown;
  } = {},
): Stripe.Event {
  return {
    id: 'evt_test_abc',
    object: 'event',
    api_version: '2025-09-30.basil',
    created: 1_700_000_000,
    data: { object: { id: 'sub_test_abc', foo: 'bar' } } as unknown as Stripe.Event.Data,
    livemode: false,
    pending_webhooks: 1,
    request: { id: 'req_xyz', idempotency_key: null },
    type: 'customer.subscription.created',
    ...overrides,
  } as Stripe.Event;
}

function makePrismaUniqueViolation(): Error {
  // The shape `isUniqueConstraintViolation` checks for — duck-typed to
  // dodge the Prisma namespace value-side issue we share with
  // service-identity (TS-021-followup-2).
  const err = new Error('Unique constraint failed on the fields: (`event_id`)');
  err.name = 'PrismaClientKnownRequestError';
  (err as unknown as { code: string }).code = 'P2002';
  return err;
}

describe('StripeIngressService', () => {
  describe('first-time persistence', () => {
    it('inserts a row with the verified event fields and returns "persisted"', async () => {
      const create = vi.fn().mockResolvedValue({});
      const { ingress } = buildIngress({ create });
      const event = makeEvent({ id: 'evt_first', type: 'invoice.paid', livemode: true });
      const verifiedAt = new Date('2026-05-10T18:00:00.000Z');

      const outcome = await ingress.persist({ event, verifiedAt });

      expect(outcome).toBe('persisted');
      expect(create).toHaveBeenCalledTimes(1);
      const { data } = create.mock.calls[0]![0] as {
        data: {
          eventId: string;
          eventType: string;
          apiVersion: string | null;
          livemode: boolean;
          requestId: string | null;
          payload: unknown;
          signatureVerifiedAt: Date;
        };
      };
      expect(data.eventId).toBe('evt_first');
      expect(data.eventType).toBe('invoice.paid');
      expect(data.apiVersion).toBe('2025-09-30.basil');
      expect(data.livemode).toBe(true);
      expect(data.requestId).toBe('req_xyz');
      expect(data.signatureVerifiedAt).toEqual(verifiedAt);
      // Payload is persisted byte-equivalent — drilling into the data field
      // to assert the full envelope survives.
      expect(data.payload).toEqual(event);
    });

    it('persists api_version as null when the event omits it', async () => {
      const create = vi.fn().mockResolvedValue({});
      const { ingress } = buildIngress({ create });
      const event = makeEvent({ api_version: null as unknown as string });

      await ingress.persist({ event, verifiedAt: new Date() });

      const { data } = create.mock.calls[0]![0] as { data: { apiVersion: string | null } };
      expect(data.apiVersion).toBeNull();
    });
  });

  describe('extractRequestId branches', () => {
    it('persists request id as null when event.request is null', async () => {
      const create = vi.fn().mockResolvedValue({});
      const { ingress } = buildIngress({ create });
      const event = makeEvent({ request: null });

      await ingress.persist({ event, verifiedAt: new Date() });

      const { data } = create.mock.calls[0]![0] as { data: { requestId: string | null } };
      expect(data.requestId).toBeNull();
    });

    it('accepts the older string-shaped request field', async () => {
      const create = vi.fn().mockResolvedValue({});
      const { ingress } = buildIngress({ create });
      const event = makeEvent({ request: 'req_legacy_string' as unknown as Stripe.Event.Request });

      await ingress.persist({ event, verifiedAt: new Date() });

      const { data } = create.mock.calls[0]![0] as { data: { requestId: string | null } };
      expect(data.requestId).toBe('req_legacy_string');
    });

    it('treats an empty string request as null', async () => {
      const create = vi.fn().mockResolvedValue({});
      const { ingress } = buildIngress({ create });
      const event = makeEvent({ request: '' as unknown as Stripe.Event.Request });

      await ingress.persist({ event, verifiedAt: new Date() });

      const { data } = create.mock.calls[0]![0] as { data: { requestId: string | null } };
      expect(data.requestId).toBeNull();
    });

    it('treats a malformed object request as null', async () => {
      const create = vi.fn().mockResolvedValue({});
      const { ingress } = buildIngress({ create });
      const event = makeEvent({
        request: { idempotency_key: 'whatever' } as unknown as Stripe.Event.Request,
      });

      await ingress.persist({ event, verifiedAt: new Date() });

      const { data } = create.mock.calls[0]![0] as { data: { requestId: string | null } };
      expect(data.requestId).toBeNull();
    });
  });

  describe('duplicate replay path', () => {
    it('returns "duplicate" when create raises P2002 (unique constraint)', async () => {
      const create = vi.fn().mockRejectedValue(makePrismaUniqueViolation());
      const { ingress } = buildIngress({ create });
      const event = makeEvent({ id: 'evt_replay' });

      const outcome = await ingress.persist({ event, verifiedAt: new Date() });

      expect(outcome).toBe('duplicate');
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('does not double-insert on a second persist of the same event id', async () => {
      // Simulates Stripe replay: first call succeeds, second call hits P2002.
      let callCount = 0;
      const create = vi.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve({});
        }
        return Promise.reject(makePrismaUniqueViolation());
      });
      const { ingress } = buildIngress({ create });
      const event = makeEvent({ id: 'evt_doubled' });
      const verifiedAt = new Date();

      const first = await ingress.persist({ event, verifiedAt });
      const second = await ingress.persist({ event, verifiedAt });

      expect(first).toBe('persisted');
      expect(second).toBe('duplicate');
      expect(create).toHaveBeenCalledTimes(2);
    });
  });

  describe('KYC dispatch hookup (TS-026)', () => {
    it('calls KYC dispatcher for identity.verification_session.* events', async () => {
      const dispatch = vi.fn().mockResolvedValue('applied');
      const markDispatched = vi.fn().mockResolvedValue(undefined);
      const { ingress } = buildIngress({
        kycDispatch: dispatch,
        kycMarkDispatched: markDispatched,
      });
      const event = makeEvent({
        id: 'evt_kyc',
        type: 'identity.verification_session.verified',
      });

      const outcome = await ingress.persist({ event, verifiedAt: new Date() });

      expect(outcome).toBe('persisted');
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(markDispatched).toHaveBeenCalledWith('evt_kyc');
    });

    it('does NOT call KYC dispatcher for non-identity events', async () => {
      const dispatch = vi.fn().mockResolvedValue(null);
      const { ingress } = buildIngress({ kycDispatch: dispatch });
      const event = makeEvent({ type: 'customer.subscription.created' });

      await ingress.persist({ event, verifiedAt: new Date() });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('does NOT stamp dispatched_at when dispatcher returns null (no-op / failure)', async () => {
      const dispatch = vi.fn().mockResolvedValue(null);
      const markDispatched = vi.fn().mockResolvedValue(undefined);
      const { ingress } = buildIngress({
        kycDispatch: dispatch,
        kycMarkDispatched: markDispatched,
      });
      const event = makeEvent({ type: 'identity.verification_session.processing' });

      await ingress.persist({ event, verifiedAt: new Date() });

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(markDispatched).not.toHaveBeenCalled();
    });

    it('stamps dispatched_at on every successful dispatch outcome (applied / replayed / session_mismatch)', async () => {
      const outcomes = ['applied', 'replayed', 'session_mismatch'] as const;
      for (const outcome of outcomes) {
        const dispatch = vi.fn().mockResolvedValue(outcome);
        const markDispatched = vi.fn().mockResolvedValue(undefined);
        const { ingress } = buildIngress({
          kycDispatch: dispatch,
          kycMarkDispatched: markDispatched,
        });
        await ingress.persist({
          event: makeEvent({
            id: `evt_${outcome}`,
            type: 'identity.verification_session.verified',
          }),
          verifiedAt: new Date(),
        });
        expect(markDispatched).toHaveBeenCalledWith(`evt_${outcome}`);
      }
    });

    it('does NOT call dispatcher when persist hit the duplicate-replay fast path', async () => {
      const create = vi.fn().mockRejectedValue(makePrismaUniqueViolation());
      const dispatch = vi.fn();
      const { ingress } = buildIngress({ create, kycDispatch: dispatch });
      const event = makeEvent({ type: 'identity.verification_session.verified' });

      const outcome = await ingress.persist({ event, verifiedAt: new Date() });
      expect(outcome).toBe('duplicate');
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('non-P2002 DB errors', () => {
    it('re-throws unexpected database errors so the controller can return 500', async () => {
      const err = new Error('FATAL: connection terminated');
      const create = vi.fn().mockRejectedValue(err);
      const { ingress } = buildIngress({ create });
      const event = makeEvent();

      await expect(ingress.persist({ event, verifiedAt: new Date() })).rejects.toBe(err);
    });

    it('re-throws an error whose code looks like P2002 but name does not match', async () => {
      // Defence-in-depth: only the exact `PrismaClientKnownRequestError`
      // shape counts as a duplicate. A custom error with `code: 'P2002'`
      // from a non-Prisma path is treated as unknown and propagated.
      const err = new Error('lookalike error');
      (err as unknown as { code: string }).code = 'P2002';
      const create = vi.fn().mockRejectedValue(err);
      const { ingress } = buildIngress({ create });

      await expect(ingress.persist({ event: makeEvent(), verifiedAt: new Date() })).rejects.toBe(
        err,
      );
    });
  });

  describe('outbox relay (TS-041a-followup-2)', () => {
    it('appends the relay event inside the same transaction as the ingress row', async () => {
      const { ingress, prisma, outbox } = buildIngress();
      const event = makeEvent({
        id: 'evt_relay',
        type: 'customer.subscription.updated',
        data: {
          object: { id: 'sub_relay', customer: 'cus_relay' },
        } as unknown as Stripe.Event.Data,
      });

      const outcome = await ingress.persist({ event, verifiedAt: new Date() });

      expect(outcome).toBe('persisted');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(outbox.append).toHaveBeenCalledTimes(1);

      const [tx, appendArgs] = outbox.append.mock.calls[0] as [
        unknown,
        {
          eventName: string;
          eventId: string;
          occurredAt: Date;
          payload: Record<string, unknown>;
        },
      ];
      // The executor handed to `append` is the TRANSACTION client, not the
      // top-level Prisma client — that is the whole outbox invariant, and a
      // refactor that reaches for `this.prisma` instead would still pass every
      // other assertion in this file.
      expect(tx).toHaveProperty('$executeRaw');
      expect(appendArgs.eventName).toBe('stripe.subscription.changed');
      expect(appendArgs.eventId).toBe('evt_relay');
      expect(appendArgs.occurredAt).toEqual(new Date(1_700_000_000 * 1000));
      expect(appendArgs.payload.stripeSubscriptionId).toBe('sub_relay');
      expect(appendArgs.payload.stripeCustomerId).toBe('cus_relay');
    });

    it('records the relay metric with the platform event name', async () => {
      const { ingress, metrics } = buildIngress();

      await ingress.persist({
        event: makeEvent({
          type: 'invoice.payment_failed',
          data: { object: { id: 'in_x' } } as unknown as Stripe.Event.Data,
        }),
        verifiedAt: new Date(),
      });

      expect(metrics.recordStripeRelayAppended).toHaveBeenCalledTimes(1);
      expect(metrics.recordStripeRelayAppended).toHaveBeenCalledWith('stripe.invoice.changed');
    });

    it('does NOT append for a Stripe event type outside the allow-list', async () => {
      const { ingress, outbox, metrics } = buildIngress();

      const outcome = await ingress.persist({
        event: makeEvent({ type: 'identity.verification_session.verified' }),
        verifiedAt: new Date(),
      });

      expect(outcome).toBe('persisted');
      expect(outbox.append).not.toHaveBeenCalled();
      expect(metrics.recordStripeRelayAppended).not.toHaveBeenCalled();
    });

    it('does NOT append on the duplicate-replay path', async () => {
      // The outbox row was written by the original transaction. Appending a
      // second one on a Stripe redelivery would put the same billing change on
      // the bus twice under a NEW row that shares the old event id — the
      // primary key would reject it, turning a benign replay into a 500.
      const create = vi.fn().mockRejectedValue(makePrismaUniqueViolation());
      const { ingress, outbox } = buildIngress({ create });

      const outcome = await ingress.persist({
        event: makeEvent({ type: 'customer.subscription.deleted' }),
        verifiedAt: new Date(),
      });

      expect(outcome).toBe('duplicate');
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('THROWS when the outbox rejects the payload, so the ingress row rolls back', async () => {
      // The asymmetry that matters: committing the ingress row after a failed
      // append would make Stripe's retry a no-op duplicate, and the billing
      // change would be lost with nothing anywhere recording it.
      const append = vi.fn().mockResolvedValue({
        kind: 'validation_failed',
        eventName: 'stripe.subscription.changed',
        issues: [{ path: ['stripeSubscriptionId'], message: 'Required' }],
      });
      const { ingress } = buildIngress({ append });

      await expect(ingress.persist({ event: makeEvent(), verifiedAt: new Date() })).rejects.toThrow(
        /outbox rejected stripe\.subscription\.changed/,
      );
    });

    it('THROWS before opening a transaction when an allow-listed event has no object id', async () => {
      const { ingress, prisma } = buildIngress();
      const event = makeEvent({
        type: 'invoice.created',
        data: { object: { customer: 'cus_x' } } as unknown as Stripe.Event.Data,
      });

      await expect(ingress.persist({ event, verifiedAt: new Date() })).rejects.toThrow(
        /missing invoice id/,
      );
      // Mapping is pure and runs first — no connection was held to find out.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not run the KYC hop inside the transaction', async () => {
      // An HTTP round-trip inside an open transaction holds a pooled
      // connection for the duration of someone else's availability. Asserted
      // by recorded ORDER, not by call counts — counts pass either way.
      const order: string[] = [];
      const create = vi.fn().mockImplementation(() => {
        order.push('insert');
        return Promise.resolve({});
      });
      const dispatch = vi.fn().mockImplementation(() => {
        order.push('kyc-dispatch');
        return Promise.resolve('applied');
      });
      const { ingress, prisma } = buildIngress({ create, kycDispatch: dispatch });
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        order.push('tx-open');
        const result = await fn({ stripeProcessedEvent: { create }, $executeRaw: vi.fn() });
        order.push('tx-commit');
        return result;
      });

      await ingress.persist({
        event: makeEvent({ type: 'identity.verification_session.verified' }),
        verifiedAt: new Date(),
      });

      expect(order).toEqual(['tx-open', 'insert', 'tx-commit', 'kyc-dispatch']);
    });
  });
});
