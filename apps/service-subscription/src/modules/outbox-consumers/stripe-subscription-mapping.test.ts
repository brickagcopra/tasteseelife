import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import {
  StripeSubscriptionShapeError,
  changedFields,
  historyEventForStatus,
  mapStripeStatus,
  mapStripeSubscription,
  type ReconcilableSubscriptionFields,
} from './stripe-subscription-mapping';

const PERIOD_START = 1_754_000_000;
const PERIOD_END = 1_756_678_400;
const OBSERVED_AT = new Date('2026-08-01T12:00:00.000Z');

function makeSubscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: 'sub_1',
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
  } as unknown as Stripe.Subscription;
}

const CURRENT: ReconcilableSubscriptionFields = {
  status: 'active',
  currentPeriodStart: new Date(PERIOD_START * 1000),
  currentPeriodEnd: new Date(PERIOD_END * 1000),
  trialEnd: null,
  cancelAtPeriodEnd: false,
  canceledAt: null,
  pauseCollectionStartedAt: null,
  pauseCollectionResumesAt: null,
  pauseReason: null,
};

describe('mapStripeStatus', () => {
  it('maps each Stripe status onto the identically-named local status', () => {
    for (const status of [
      'incomplete',
      'incomplete_expired',
      'trialing',
      'active',
      'past_due',
      'unpaid',
      'canceled',
      'paused',
    ]) {
      expect(mapStripeStatus(makeSubscription({ status }))).toEqual({
        kind: 'mapped',
        status,
      });
    }
  });

  it('reports an unrecognised Stripe status instead of coercing it', () => {
    expect(mapStripeStatus(makeSubscription({ status: 'some_future_status' }))).toEqual({
      kind: 'unknown_status',
      stripeStatus: 'some_future_status',
    });
  });

  it('PAUSE_COLLECTION WINS OVER STATUS — a paused subscription never reads as active', () => {
    // The single most consequential mapping decision here. Stripe does NOT
    // change `subscription.status` when collection is paused; it stays
    // `active`. This platform's `paused` status IS "collection paused" —
    // `DunningService.pauseCollection` writes it. Copying Stripe's `status`
    // across would flip every paused subscription back to `active` on the
    // very next webhook: the platform would show a family as actively
    // billing while Stripe collected nothing, and nothing would report the
    // disagreement.
    const pausedButActive = makeSubscription({
      status: 'active',
      pause_collection: { behavior: 'void', resumes_at: null },
    });
    expect(mapStripeStatus(pausedButActive)).toEqual({ kind: 'mapped', status: 'paused' });
  });

  it('still reports paused when Stripe`s own status is trialing under a pause', () => {
    expect(
      mapStripeStatus(
        makeSubscription({
          status: 'trialing',
          pause_collection: { behavior: 'keep_as_draft', resumes_at: null },
        }),
      ),
    ).toEqual({ kind: 'mapped', status: 'paused' });
  });
});

describe('mapStripeSubscription — field mapping', () => {
  it('converts Stripe unix seconds to Dates', () => {
    const result = mapStripeSubscription({
      subscription: makeSubscription({ trial_end: 1_755_000_000, canceled_at: 1_755_500_000 }),
      existing: { pauseCollectionStartedAt: null, pauseReason: null },
      observedAt: OBSERVED_AT,
    });

    expect(result.kind).toBe('mapped');
    if (result.kind !== 'mapped') return;
    expect(result.fields.currentPeriodStart).toEqual(new Date(PERIOD_START * 1000));
    expect(result.fields.currentPeriodEnd).toEqual(new Date(PERIOD_END * 1000));
    expect(result.fields.trialEnd).toEqual(new Date(1_755_000_000 * 1000));
    expect(result.fields.canceledAt).toEqual(new Date(1_755_500_000 * 1000));
  });

  it('returns unknown_status WITHOUT any fields — a partial write is worse than a stale row', () => {
    const result = mapStripeSubscription({
      subscription: makeSubscription({ status: 'quantum_superposition' }),
      existing: { pauseCollectionStartedAt: null, pauseReason: null },
      observedAt: OBSERVED_AT,
    });
    expect(result).toEqual({ kind: 'unknown_status', stripeStatus: 'quantum_superposition' });
    expect(result).not.toHaveProperty('fields');
  });

  it('reads the billing period from the subscription ITEM when the top level lacks it', () => {
    // API version 2025-03-31 moved the period boundaries onto each item.
    // Reading only the top level would put the epoch into a billing period.
    const result = mapStripeSubscription({
      subscription: makeSubscription({
        current_period_start: undefined,
        current_period_end: undefined,
        items: {
          object: 'list',
          data: [{ current_period_start: PERIOD_START, current_period_end: PERIOD_END }],
          has_more: false,
          url: '',
        },
      }),
      existing: { pauseCollectionStartedAt: null, pauseReason: null },
      observedAt: OBSERVED_AT,
    });

    expect(result.kind).toBe('mapped');
    if (result.kind !== 'mapped') return;
    expect(result.fields.currentPeriodStart).toEqual(new Date(PERIOD_START * 1000));
  });

  it('THROWS rather than defaulting when neither shape carries a period', () => {
    // A subscription whose period silently became 1970 reads as wildly
    // overdue to every sweep and dashboard that touches it.
    expect(() =>
      mapStripeSubscription({
        subscription: makeSubscription({
          current_period_start: undefined,
          current_period_end: undefined,
        }),
        existing: { pauseCollectionStartedAt: null, pauseReason: null },
        observedAt: OBSERVED_AT,
      }),
    ).toThrow(StripeSubscriptionShapeError);
  });
});

describe('mapStripeSubscription — pause fields', () => {
  it('PRESERVES a local pause stamp rather than re-dating our own pause', () => {
    const ourPause = new Date('2026-07-20T09:00:00.000Z');
    const result = mapStripeSubscription({
      subscription: makeSubscription({
        pause_collection: { behavior: 'void', resumes_at: null },
      }),
      existing: { pauseCollectionStartedAt: ourPause, pauseReason: 'hospital stay' },
      observedAt: OBSERVED_AT,
    });

    expect(result.kind).toBe('mapped');
    if (result.kind !== 'mapped') return;
    expect(result.fields.pauseCollectionStartedAt).toEqual(ourPause);
    // Free text we hold and Stripe has never seen. It explains the pause, so
    // it survives as long as the pause does.
    expect(result.fields.pauseReason).toBe('hospital stay');
  });

  it('stamps an out-of-band pause with when we OBSERVED it — Stripe never says when', () => {
    const result = mapStripeSubscription({
      subscription: makeSubscription({
        pause_collection: { behavior: 'void', resumes_at: 1_757_000_000 },
      }),
      existing: { pauseCollectionStartedAt: null, pauseReason: null },
      observedAt: OBSERVED_AT,
    });

    expect(result.kind).toBe('mapped');
    if (result.kind !== 'mapped') return;
    expect(result.fields.pauseCollectionStartedAt).toEqual(OBSERVED_AT);
    expect(result.fields.pauseCollectionResumesAt).toEqual(new Date(1_757_000_000 * 1000));
  });

  it('clears all three pause fields when Stripe reports the pause gone', () => {
    const result = mapStripeSubscription({
      subscription: makeSubscription({ pause_collection: null }),
      existing: {
        pauseCollectionStartedAt: new Date('2026-07-20T09:00:00.000Z'),
        pauseReason: 'hospital stay',
      },
      observedAt: OBSERVED_AT,
    });

    expect(result.kind).toBe('mapped');
    if (result.kind !== 'mapped') return;
    expect(result.fields.pauseCollectionStartedAt).toBeNull();
    expect(result.fields.pauseCollectionResumesAt).toBeNull();
    // The reason explained a pause that is over. Leaving it would make a
    // resumed subscription read as still-paused on every admin screen.
    expect(result.fields.pauseReason).toBeNull();
  });

  it('never invents a pauseReason from Stripe — there is no such field there', () => {
    const result = mapStripeSubscription({
      subscription: makeSubscription({
        pause_collection: { behavior: 'void', resumes_at: null },
      }),
      existing: { pauseCollectionStartedAt: null, pauseReason: null },
      observedAt: OBSERVED_AT,
    });
    expect(result.kind).toBe('mapped');
    if (result.kind !== 'mapped') return;
    expect(result.fields.pauseReason).toBeNull();
  });
});

describe('changedFields', () => {
  it('is empty when nothing moved — the redelivery case', () => {
    expect(changedFields(CURRENT, CURRENT)).toEqual([]);
  });

  it('compares Dates by value, not by identity', () => {
    // Prisma hands back fresh Date instances on every read; identity
    // comparison would report every field as changed on every event, and the
    // append-only history would grow a row per webhook delivery.
    const sameValues: ReconcilableSubscriptionFields = {
      ...CURRENT,
      currentPeriodStart: new Date(PERIOD_START * 1000),
      currentPeriodEnd: new Date(PERIOD_END * 1000),
    };
    expect(changedFields(sameValues, CURRENT)).toEqual([]);
  });

  it('names exactly the fields that differ', () => {
    const next: ReconcilableSubscriptionFields = {
      ...CURRENT,
      status: 'past_due',
      cancelAtPeriodEnd: true,
    };
    expect([...changedFields(next, CURRENT)].sort()).toEqual(['cancelAtPeriodEnd', 'status']);
  });

  it('treats null → a Date as a change and back again', () => {
    const withTrial: ReconcilableSubscriptionFields = { ...CURRENT, trialEnd: new Date(0) };
    expect(changedFields(withTrial, CURRENT)).toEqual(['trialEnd']);
    expect(changedFields(CURRENT, withTrial)).toEqual(['trialEnd']);
  });
});

describe('historyEventForStatus', () => {
  it('uses the dedicated enum member for canceled and paused', () => {
    expect(historyEventForStatus('canceled')).toBe('canceled');
    expect(historyEventForStatus('paused')).toBe('paused');
  });

  it('falls back to status_changed for everything else', () => {
    for (const status of ['active', 'past_due', 'unpaid', 'trialing', 'incomplete'] as const) {
      expect(historyEventForStatus(status)).toBe('status_changed');
    }
  });
});
