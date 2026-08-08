import Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutboxService } from '@taste-and-see/nest-outbox';

import type { PrismaService } from '../../prisma/prisma.service';
import { StripeSubscriptionReconcilerService } from './stripe-subscription-reconciler.service';

const PERIOD_START = 1_754_000_000;
const PERIOD_END = 1_756_678_400;
const OBSERVED_AT = new Date('2026-08-01T12:00:00.000Z');

interface Harness {
  readonly service: StripeSubscriptionReconcilerService;
  readonly findUnique: ReturnType<typeof vi.fn>;
  readonly update: ReturnType<typeof vi.fn>;
  readonly historyCreate: ReturnType<typeof vi.fn>;
  readonly retrieve: ReturnType<typeof vi.fn>;
  readonly append: ReturnType<typeof vi.fn>;
}

function existingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sub_local_1',
    customerId: 'hh_local_1',
    status: 'active',
    currentPeriodStart: new Date(PERIOD_START * 1000),
    currentPeriodEnd: new Date(PERIOD_END * 1000),
    trialEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    pauseCollectionStartedAt: null,
    pauseCollectionResumesAt: null,
    pauseReason: null,
    ...overrides,
  };
}

function stripeSubscription(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'sub_stripe_1',
    object: 'subscription',
    status: 'active',
    cancel_at_period_end: false,
    canceled_at: null,
    trial_end: null,
    pause_collection: null,
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    items: { object: 'list', data: [], has_more: false, url: '' },
    ...overrides,
  };
}

function build(args?: {
  readonly existing?: Record<string, unknown> | null;
  readonly retrieve?: ReturnType<typeof vi.fn>;
  readonly append?: ReturnType<typeof vi.fn>;
}): Harness {
  const findUnique = vi
    .fn()
    .mockResolvedValue(args?.existing === undefined ? existingRow() : args.existing);
  const update = vi.fn().mockResolvedValue({});
  const historyCreate = vi.fn().mockResolvedValue({});
  const retrieve = args?.retrieve ?? vi.fn().mockResolvedValue(stripeSubscription());

  const tx = {
    subscription: { update },
    subscriptionHistory: { create: historyCreate },
  };
  const prisma = {
    subscription: { findUnique },
    $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
  };
  const stripe = { subscriptions: { retrieve } };
  const append =
    args?.append ?? vi.fn().mockResolvedValue({ kind: 'appended', eventId: 'evt_out_1' });
  const outbox = { append };

  const service = new StripeSubscriptionReconcilerService(
    prisma as unknown as PrismaService,
    stripe as unknown as Stripe,
    outbox as unknown as OutboxService,
  );
  return { service, findUnique, update, historyCreate, retrieve, append };
}

function reconcile(service: StripeSubscriptionReconcilerService) {
  return service.reconcile({
    stripeSubscriptionId: 'sub_stripe_1',
    stripeEventId: 'evt_1',
    stripeEventType: 'customer.subscription.updated',
    observedAt: OBSERVED_AT,
  });
}

describe('StripeSubscriptionReconcilerService — untracked subscriptions', () => {
  it('is a NO-OP for a Stripe subscription with no local row', async () => {
    // Platform subscriptions are created through this service, which writes
    // the customerId / customerGroup / planId only the creating request
    // knows. A `sub_...` with no local row is out-of-band Dashboard activity
    // or the narrow create race — and in that race the creating request has
    // already written correct state. Manufacturing a row from the webhook
    // would mean guessing the plan that governs a family's entitlements.
    const { service, retrieve, update } = build({ existing: null });

    await expect(reconcile(service)).resolves.toEqual({ kind: 'not_tracked' });
    expect(update).not.toHaveBeenCalled();
    // And it does not even spend a Stripe call to find out.
    expect(retrieve).not.toHaveBeenCalled();
  });
});

describe('StripeSubscriptionReconcilerService — Stripe fetch', () => {
  it('re-fetches from Stripe rather than trusting the event', async () => {
    const { service, retrieve } = build();
    await reconcile(service);
    expect(retrieve).toHaveBeenCalledWith('sub_stripe_1');
  });

  it('treats resource_missing as TERMINAL — no throw, no write', async () => {
    // A permanent 404 cannot be fixed by asking again; ten redeliveries spend
    // ten Stripe calls to say what one metric increment already said.
    const missing = new Stripe.errors.StripeInvalidRequestError({
      type: 'invalid_request_error',
      code: 'resource_missing',
      message: 'No such subscription',
    });
    const { service, update } = build({ retrieve: vi.fn().mockRejectedValue(missing) });

    await expect(reconcile(service)).resolves.toEqual({ kind: 'stripe_missing' });
    expect(update).not.toHaveBeenCalled();
  });

  it('RE-THROWS a transient Stripe failure so the SDK retries', async () => {
    // The other half of the split. Swallowing a network blip would silently
    // abandon a real billing change.
    const boom = new Error('ECONNRESET');
    const { service } = build({ retrieve: vi.fn().mockRejectedValue(boom) });

    await expect(reconcile(service)).rejects.toBe(boom);
  });

  it('RE-THROWS a Stripe invalid-request error that is NOT resource_missing', async () => {
    const other = new Stripe.errors.StripeInvalidRequestError({
      type: 'invalid_request_error',
      code: 'parameter_invalid_empty',
      message: 'bad request',
    });
    const { service } = build({ retrieve: vi.fn().mockRejectedValue(other) });

    await expect(reconcile(service)).rejects.toBe(other);
  });
});

describe('StripeSubscriptionReconcilerService — writing', () => {
  it('writes nothing when Stripe already agrees with the local row', async () => {
    const { service, update, historyCreate } = build();

    await expect(reconcile(service)).resolves.toEqual({ kind: 'no_change' });
    expect(update).not.toHaveBeenCalled();
    expect(historyCreate).not.toHaveBeenCalled();
  });

  it('updates the row and records history on a status change', async () => {
    const { service, update, historyCreate } = build({
      retrieve: vi.fn().mockResolvedValue(stripeSubscription({ status: 'past_due' })),
    });

    const outcome = await reconcile(service);
    expect(outcome).toEqual({ kind: 'reconciled', changed: ['status'] });

    expect(update).toHaveBeenCalledTimes(1);
    const updateArg = update.mock.calls[0]![0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updateArg.where.id).toBe('sub_local_1');
    expect(updateArg.data.status).toBe('past_due');

    expect(historyCreate).toHaveBeenCalledTimes(1);
    const historyArg = historyCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(historyArg.data.event).toBe('status_changed');
    expect(historyArg.data.fromStatus).toBe('active');
    expect(historyArg.data.toStatus).toBe('past_due');
    expect(historyArg.data.actorUserId).toBeNull();
    expect(historyArg.data.actorKind).toBe('system');
    // Traceable back to the exact Stripe delivery that caused it.
    expect(historyArg.data.source).toBe('evt_1');
  });

  it('does NOT write history for a field change that is not a status change', async () => {
    // `subscription_history` is append-only and records TRANSITIONS. A period
    // roll on every billing cycle is a field change; a row for each would
    // bury the status transitions the table exists for.
    const { service, update, historyCreate } = build({
      retrieve: vi
        .fn()
        .mockResolvedValue(stripeSubscription({ current_period_end: PERIOD_END + 86_400 })),
    });

    const outcome = await reconcile(service);
    expect(outcome).toEqual({ kind: 'reconciled', changed: ['currentPeriodEnd'] });
    expect(update).toHaveBeenCalledTimes(1);
    expect(historyCreate).not.toHaveBeenCalled();
  });

  it('records a cancellation under the `canceled` history event', async () => {
    const { service, historyCreate } = build({
      retrieve: vi
        .fn()
        .mockResolvedValue(stripeSubscription({ status: 'canceled', canceled_at: PERIOD_END })),
    });

    await reconcile(service);
    const historyArg = historyCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(historyArg.data.event).toBe('canceled');
  });

  it('does NOT flip a locally-paused subscription back to active', async () => {
    // The end-to-end statement of the mapper's pause_collection rule. Stripe
    // keeps `status: 'active'` while collection is paused; without the rule
    // this reconciliation would un-pause a family's billing on the next
    // webhook and write a history row saying we did it deliberately.
    const { service, update, historyCreate } = build({
      existing: existingRow({
        status: 'paused',
        pauseCollectionStartedAt: new Date('2026-07-20T09:00:00.000Z'),
        pauseReason: 'hospital stay',
      }),
      retrieve: vi.fn().mockResolvedValue(
        stripeSubscription({
          status: 'active',
          pause_collection: { behavior: 'void', resumes_at: null },
        }),
      ),
    });

    await expect(reconcile(service)).resolves.toEqual({ kind: 'no_change' });
    expect(update).not.toHaveBeenCalled();
    expect(historyCreate).not.toHaveBeenCalled();
  });

  it('resumes a subscription Stripe un-paused out of band', async () => {
    const { service, update, historyCreate } = build({
      existing: existingRow({
        status: 'paused',
        pauseCollectionStartedAt: new Date('2026-07-20T09:00:00.000Z'),
        pauseReason: 'hospital stay',
      }),
      retrieve: vi.fn().mockResolvedValue(stripeSubscription({ status: 'active' })),
    });

    const outcome = await reconcile(service);
    expect(outcome.kind).toBe('reconciled');

    const updateArg = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(updateArg.data.status).toBe('active');
    expect(updateArg.data.pauseCollectionStartedAt).toBeNull();
    expect(updateArg.data.pauseReason).toBeNull();
    expect(historyCreate).toHaveBeenCalledTimes(1);
  });

  it('WRITES NOTHING on an unmappable Stripe status', async () => {
    // Being visibly stale is recoverable; being confidently wrong about
    // whether a family is billing is not.
    const { service, update, historyCreate } = build({
      retrieve: vi.fn().mockResolvedValue(stripeSubscription({ status: 'brand_new_status' })),
    });

    await expect(reconcile(service)).resolves.toEqual({
      kind: 'unknown_status',
      stripeStatus: 'brand_new_status',
    });
    expect(update).not.toHaveBeenCalled();
    expect(historyCreate).not.toHaveBeenCalled();
  });

  it('never writes dunning or plan fields', async () => {
    // Each has an owner this reconciler would overwrite: DunningService holds
    // the grace window a family is currently inside, and plan drives
    // entitlement.
    const { service, update } = build({
      retrieve: vi.fn().mockResolvedValue(stripeSubscription({ status: 'past_due' })),
    });

    await reconcile(service);
    const data = (update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    for (const forbidden of [
      'dunningAttempts',
      'dunningLastAttemptAt',
      'dunningGraceUntil',
      'planId',
      'billingInterval',
      'defaultPaymentMethodId',
      'stripeCustomerId',
      'customerId',
    ]) {
      expect(data, `reconciler must not own ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });
});

describe('StripeSubscriptionReconcilerService — convergence', () => {
  let calls = 0;

  beforeEach(() => {
    calls = 0;
  });

  it('is idempotent: a second run against unchanged Stripe state writes nothing', async () => {
    // This is what makes the dedup table SECONDARY rather than load-bearing.
    const local = existingRow();
    const findUnique = vi.fn().mockImplementation(() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? local : { ...local, status: 'past_due' });
    });
    const update = vi.fn().mockResolvedValue({});
    const historyCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      subscription: { findUnique },
      $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
        fn({ subscription: { update }, subscriptionHistory: { create: historyCreate } }),
      ),
    };
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue(stripeSubscription({ status: 'past_due' })),
      },
    };
    const outbox = {
      append: vi.fn().mockResolvedValue({ kind: 'appended', eventId: 'evt_out_1' }),
    };
    const service = new StripeSubscriptionReconcilerService(
      prisma as unknown as PrismaService,
      stripe as unknown as Stripe,
      outbox as unknown as OutboxService,
    );

    const first = await reconcile(service);
    const second = await reconcile(service);

    expect(first.kind).toBe('reconciled');
    expect(second.kind).toBe('no_change');
    expect(update).toHaveBeenCalledTimes(1);
    expect(historyCreate).toHaveBeenCalledTimes(1);
  });
});

/**
 * TS-042-followup-3b2-followup-1 — the reconciler is the SECOND producer of
 * `subscription.paused` / `subscription.resumed`.
 *
 * Before this, the only producer was the explicit
 * `DunningService.pause/resumeSubscription` call. A pause created with
 * `resumesAt` is resumed BY STRIPE when that instant arrives, and that path
 * runs through here — it updated the local row and told nobody, so
 * service-accounting's deferred-revenue balance stayed suspended forever
 * while this service and Stripe both looked correct.
 */
describe('StripeSubscriptionReconcilerService — out-of-band pause / resume events', () => {
  const PAUSED_AT = new Date('2026-07-20T00:00:00.000Z');

  function pausedLocalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return existingRow({
      status: 'paused',
      pauseCollectionStartedAt: PAUSED_AT,
      pauseCollectionResumesAt: new Date('2026-08-01T00:00:00.000Z'),
      pauseReason: 'family travelling',
      ...overrides,
    });
  }

  it('emits subscription.resumed when Stripe auto-resumes collection', async () => {
    // Local row is paused; Stripe reports pause_collection cleared.
    const { service, append } = build({
      existing: pausedLocalRow(),
      retrieve: vi
        .fn()
        .mockResolvedValue(stripeSubscription({ status: 'active', pause_collection: null })),
    });

    await expect(reconcile(service)).resolves.toMatchObject({ kind: 'reconciled' });

    expect(append).toHaveBeenCalledTimes(1);
    const call = append.mock.calls[0];
    if (call === undefined) throw new Error('expected one append');
    const record = call[1] as {
      eventName: string;
      eventId: string;
      payload: Record<string, unknown>;
    };
    expect(record.eventName).toBe('subscription.resumed');
    expect(record.payload['subscriptionId']).toBe('sub_local_1');
    expect(record.payload['customerId']).toBe('hh_local_1');
    expect(record.payload['toStatus']).toBe('active');
  });

  it('emits with requesterUserId null — nobody here requested it', async () => {
    const { service, append } = build({
      existing: pausedLocalRow(),
      retrieve: vi
        .fn()
        .mockResolvedValue(stripeSubscription({ status: 'active', pause_collection: null })),
    });

    await reconcile(service);

    const call = append.mock.calls[0];
    if (call === undefined) throw new Error('expected one append');
    const payload = (call[1] as { payload: Record<string, unknown> }).payload;
    // A sentinel user id would put a value that is not a user into a field
    // typed as one. `null` IS the discriminator.
    expect(payload['requesterUserId']).toBeNull();
  });

  it('carries the OBSERVATION instant as resumedAt — Stripe never says when', async () => {
    const { service, append } = build({
      existing: pausedLocalRow(),
      retrieve: vi
        .fn()
        .mockResolvedValue(stripeSubscription({ status: 'active', pause_collection: null })),
    });

    await reconcile(service);

    const call = append.mock.calls[0];
    if (call === undefined) throw new Error('expected one append');
    const payload = (call[1] as { payload: Record<string, unknown> }).payload;
    expect(payload['resumedAt']).toBe(OBSERVED_AT.toISOString());
  });

  it('reports the status Stripe actually gives, not active — a mid-dunning pause resumes past_due', async () => {
    const { service, append } = build({
      existing: pausedLocalRow(),
      retrieve: vi
        .fn()
        .mockResolvedValue(stripeSubscription({ status: 'past_due', pause_collection: null })),
    });

    await reconcile(service);

    const call = append.mock.calls[0];
    if (call === undefined) throw new Error('expected one append');
    const payload = (call[1] as { payload: Record<string, unknown> }).payload;
    expect(payload['toStatus']).toBe('past_due');
  });

  it('emits subscription.paused when collection is paused out of band', async () => {
    const { service, append } = build({
      existing: existingRow(),
      retrieve: vi.fn().mockResolvedValue(
        stripeSubscription({
          status: 'active',
          pause_collection: { behavior: 'void', resumes_at: null },
        }),
      ),
    });

    await reconcile(service);

    expect(append).toHaveBeenCalledTimes(1);
    const call = append.mock.calls[0];
    if (call === undefined) throw new Error('expected one append');
    const record = call[1] as { eventName: string; payload: Record<string, unknown> };
    expect(record.eventName).toBe('subscription.paused');
    expect(record.payload['fromStatus']).toBe('active');
    expect(record.payload['requesterUserId']).toBeNull();
    // A Dashboard pause carries no reason — `pauseReason` is only ever
    // written by this platform's own pause endpoint.
    expect(record.payload['hasReason']).toBe(false);
  });

  it('carries no free text in either payload', async () => {
    const { service, append } = build({
      existing: pausedLocalRow(),
      retrieve: vi
        .fn()
        .mockResolvedValue(stripeSubscription({ status: 'active', pause_collection: null })),
    });

    await reconcile(service);

    const call = append.mock.calls[0];
    if (call === undefined) throw new Error('expected one append');
    // The local row's `pauseReason` says "family travelling". An event
    // replicates far wider than the column it was written to, and a pause
    // reason on this platform is very often a health or bereavement
    // disclosure about a named senior (CLAUDE.md §3.9, §12).
    expect(JSON.stringify(call[1])).not.toContain('travelling');
  });

  it('does NOT emit when the pause state is unchanged', async () => {
    // A period roll on an already-paused subscription is a field change,
    // not a pause transition. Keying on `status` instead of the pause
    // columns would fire here.
    const { service, append, update } = build({
      existing: pausedLocalRow({ currentPeriodEnd: new Date(1_700_000_000 * 1000) }),
      retrieve: vi.fn().mockResolvedValue(
        stripeSubscription({
          status: 'paused',
          pause_collection: { behavior: 'void', resumes_at: null },
        }),
      ),
    });

    await reconcile(service);

    expect(update).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
  });

  it('does NOT emit for an ordinary status change with no pause involved', async () => {
    const { service, append } = build({
      existing: existingRow(),
      retrieve: vi.fn().mockResolvedValue(stripeSubscription({ status: 'past_due' })),
    });

    await reconcile(service);

    expect(append).not.toHaveBeenCalled();
  });

  it('does NOT emit a second time after the explicit resume path already wrote the row', async () => {
    // The explicit resume commits row + event together; by the time
    // Stripe's webhook arrives the pause columns agree, `changedFields` is
    // empty, and reconcile returns before the transaction.
    const { service, append, update } = build({
      existing: existingRow(),
      retrieve: vi
        .fn()
        .mockResolvedValue(stripeSubscription({ status: 'active', pause_collection: null })),
    });

    await expect(reconcile(service)).resolves.toEqual({ kind: 'no_change' });
    expect(update).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('keys the event id to the Stripe delivery, not to a history row', async () => {
    const { service, append } = build({
      existing: pausedLocalRow(),
      retrieve: vi
        .fn()
        .mockResolvedValue(stripeSubscription({ status: 'active', pause_collection: null })),
    });

    await reconcile(service);

    const call = append.mock.calls[0];
    if (call === undefined) throw new Error('expected one append');
    const record = call[1] as { eventId: string; payload: Record<string, unknown> };
    // The history row is only written when `status` changes; the transition
    // that matters here is the pause columns'.
    expect(record.eventId).toBe('sub_local_1.resumed.stripe.evt_1');
    expect(record.payload['eventId']).toBe(record.eventId);
  });

  it('appends inside the SAME transaction as the row update', async () => {
    const { service, append, update } = build({
      existing: pausedLocalRow(),
      retrieve: vi
        .fn()
        .mockResolvedValue(stripeSubscription({ status: 'active', pause_collection: null })),
    });

    await reconcile(service);

    const call = append.mock.calls[0];
    if (call === undefined) throw new Error('expected one append');
    // First argument is the executor: the tx client the update ran on, not
    // the base Prisma service. A rollback must take the event with it.
    const executor = call[0] as { subscription?: { update?: unknown } };
    expect(executor.subscription?.update).toBe(update);
  });

  it('THROWS on a rejected payload rather than committing the row without the event', async () => {
    const { service } = build({
      existing: pausedLocalRow(),
      retrieve: vi
        .fn()
        .mockResolvedValue(stripeSubscription({ status: 'active', pause_collection: null })),
      append: vi
        .fn()
        .mockResolvedValue({ kind: 'invalid', eventName: 'subscription.resumed', issues: [] }),
    });

    // Committing the state change and dropping the event is the exact
    // silent divergence this emission exists to close.
    await expect(reconcile(service)).rejects.toThrow(/subscription\.resumed/);
  });
});
