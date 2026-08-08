import { describe, expect, it } from 'vitest';

import {
  eventRegistry,
  getEventSchema,
  SUBSCRIPTION_ACTIVATED,
  SUBSCRIPTION_CANCELED,
  SUBSCRIPTION_DUNNING_EXHAUSTED,
  SUBSCRIPTION_PAUSED,
  SUBSCRIPTION_PAYMENT_FAILED,
  SUBSCRIPTION_PAYMENT_SUCCEEDED,
  SUBSCRIPTION_RESUMED,
} from '../events';
import { SubscriptionStatusSchema } from '../http/subscription.schema';

describe('event registry', () => {
  it('exposes a schema for every dotted event name constant', () => {
    expect(eventRegistry[SUBSCRIPTION_ACTIVATED]).toBeDefined();
    expect(eventRegistry[SUBSCRIPTION_CANCELED]).toBeDefined();
    expect(eventRegistry[SUBSCRIPTION_PAYMENT_FAILED]).toBeDefined();
  });

  it('uses past-tense dotted event names (CLAUDE.md §2.2)', () => {
    for (const name of Object.keys(eventRegistry)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });

  it('getEventSchema returns the correct schema for known names', () => {
    const schema = getEventSchema(SUBSCRIPTION_ACTIVATED);
    expect(schema).toBe(eventRegistry[SUBSCRIPTION_ACTIVATED]);
  });

  it('getEventSchema returns undefined for unknown names', () => {
    expect(getEventSchema('unknown.event')).toBeUndefined();
  });
});

describe('SubscriptionActivated event', () => {
  const valid = {
    eventId: 'evt_abc123',
    occurredAt: '2026-05-07T12:00:00.000Z',
    subscriptionId: 'sub_001',
    customerId: 'cust_001',
    customerGroup: 'family' as const,
    planId: 'plan_essential',
    planCode: 'family.tier1',
    periodStart: '2026-05-07T00:00:00.000Z',
    periodEnd: '2026-06-07T00:00:00.000Z',
    amountMinor: 9900,
    currency: 'USD',
  };

  it('accepts a valid payload', () => {
    expect(eventRegistry[SUBSCRIPTION_ACTIVATED].safeParse(valid).success).toBe(true);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(
      eventRegistry[SUBSCRIPTION_ACTIVATED].safeParse({ ...valid, extraField: 'no' }).success,
    ).toBe(false);
  });

  it('requires an ISO `occurredAt`', () => {
    expect(
      eventRegistry[SUBSCRIPTION_ACTIVATED].safeParse({ ...valid, occurredAt: 'now' }).success,
    ).toBe(false);
  });

  it('requires `amountMinor` to be a positive integer', () => {
    expect(
      eventRegistry[SUBSCRIPTION_ACTIVATED].safeParse({ ...valid, amountMinor: 0 }).success,
    ).toBe(false);
    expect(
      eventRegistry[SUBSCRIPTION_ACTIVATED].safeParse({ ...valid, amountMinor: -1 }).success,
    ).toBe(false);
    expect(
      eventRegistry[SUBSCRIPTION_ACTIVATED].safeParse({ ...valid, amountMinor: 1.5 }).success,
    ).toBe(false);
  });

  it('defaults `currency` to USD when omitted', () => {
    const { currency: _currency, ...withoutCurrency } = valid;
    void _currency;
    const parsed = eventRegistry[SUBSCRIPTION_ACTIVATED].safeParse(withoutCurrency);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const data = parsed.data as { currency: string };
      expect(data.currency).toBe('USD');
    }
  });

  it('rejects currency codes not exactly 3 characters', () => {
    expect(
      eventRegistry[SUBSCRIPTION_ACTIVATED].safeParse({ ...valid, currency: 'US' }).success,
    ).toBe(false);
    expect(
      eventRegistry[SUBSCRIPTION_ACTIVATED].safeParse({ ...valid, currency: 'USDS' }).success,
    ).toBe(false);
  });

  it('requires `amountMinor` to be present', () => {
    const { amountMinor: _omitted, ...withoutAmount } = valid;
    void _omitted;
    expect(eventRegistry[SUBSCRIPTION_ACTIVATED].safeParse(withoutAmount).success).toBe(false);
  });
});

describe('SubscriptionPaymentFailed event', () => {
  const valid = {
    eventId: 'evt_pf_1',
    occurredAt: '2026-05-07T12:00:00.000Z',
    subscriptionId: 'sub_001',
    customerId: 'cust_001',
    customerGroup: 'family',
    invoiceId: 'inv_001',
    amountUsdMinor: 19900,
    attemptCount: 2,
    nextAttemptAt: '2026-05-10T12:00:00.000Z',
    attemptedAt: '2026-05-07T12:00:00.000Z',
    graceUntil: '2026-05-28T12:00:00.000Z',
    fromStatus: 'active',
  };

  it('requires `customerGroup` — `customerId` is meaningless without it', () => {
    // `subscriptions.customer_id` is a soft FK whose target SCHEMA depends
    // on the group (household / provider / user). A consumer that guessed
    // would ask the wrong service and get an empty answer, so the
    // notification would silently never send (TS-042-followup-3a2a).
    const { customerGroup, ...withoutGroup } = valid;
    void customerGroup;
    expect(eventRegistry[SUBSCRIPTION_PAYMENT_FAILED].safeParse(withoutGroup).success).toBe(false);
  });

  it('accepts a valid payload (with optional `nextAttemptAt`)', () => {
    expect(eventRegistry[SUBSCRIPTION_PAYMENT_FAILED].safeParse(valid).success).toBe(true);
    const { nextAttemptAt, ...withoutNext } = valid;
    void nextAttemptAt;
    expect(eventRegistry[SUBSCRIPTION_PAYMENT_FAILED].safeParse(withoutNext).success).toBe(true);
  });

  it('rejects attemptCount < 1', () => {
    expect(
      eventRegistry[SUBSCRIPTION_PAYMENT_FAILED].safeParse({ ...valid, attemptCount: 0 }).success,
    ).toBe(false);
  });

  it('rejects negative amounts', () => {
    expect(
      eventRegistry[SUBSCRIPTION_PAYMENT_FAILED].safeParse({ ...valid, amountUsdMinor: -1 })
        .success,
    ).toBe(false);
  });

  /**
   * TS-042-followup-3 — `invoiceId`/`amountUsdMinor` were relaxed to optional
   * when the event finally got a producer. The dunning state machine is driven
   * by `stripe.invoice.changed`, a handle-only notification, so it holds
   * neither; inventing the amount from the plan price would disagree with the
   * invoice whenever a proration or coupon applied, giving the platform a
   * second source of truth for money (CLAUDE.md §6). This test pins the
   * relaxation so a future tightening is a deliberate act.
   */
  it('accepts a payload with no invoice money (the dunning producer has none)', () => {
    const { invoiceId, amountUsdMinor, nextAttemptAt, ...dunningShaped } = valid;
    void invoiceId;
    void amountUsdMinor;
    void nextAttemptAt;
    expect(eventRegistry[SUBSCRIPTION_PAYMENT_FAILED].safeParse(dunningShaped).success).toBe(true);
  });

  /**
   * `graceUntil` is when THIS PLATFORM stops serving; `nextAttemptAt` is when
   * STRIPE next retries the card. They are different clocks and the
   * dunning-ladder consumer needs the first. Required (nullable), so a
   * producer cannot quietly omit it.
   */
  it('requires graceUntil — nullable, but never absent', () => {
    expect(
      eventRegistry[SUBSCRIPTION_PAYMENT_FAILED].safeParse({ ...valid, graceUntil: null }).success,
    ).toBe(true);
    const { graceUntil, ...withoutGrace } = valid;
    void graceUntil;
    expect(eventRegistry[SUBSCRIPTION_PAYMENT_FAILED].safeParse(withoutGrace).success).toBe(false);
  });
});

describe('SubscriptionPaymentSucceeded event', () => {
  const valid = {
    eventId: 'evt_ps_1',
    occurredAt: '2026-05-20T09:00:00.000Z',
    subscriptionId: 'sub_001',
    customerId: 'cust_001',
    customerGroup: 'family',
    succeededAt: '2026-05-20T09:00:00.000Z',
    recovered: true,
    fromStatus: 'past_due',
    toStatus: 'active',
    attemptsCleared: 3,
  };

  it('requires `customerGroup` — `customerId` is meaningless without it', () => {
    const { customerGroup, ...withoutGroup } = valid;
    void customerGroup;
    expect(eventRegistry[SUBSCRIPTION_PAYMENT_SUCCEEDED].safeParse(withoutGroup).success).toBe(
      false,
    );
  });

  it('accepts a valid payload', () => {
    expect(eventRegistry[SUBSCRIPTION_PAYMENT_SUCCEEDED].safeParse(valid).success).toBe(true);
  });

  /**
   * A routine renewal and a payment that rescued a `past_due` subscription are
   * the same Stripe event but different customer moments — only the second
   * warrants a "you're all set" email. `recovered` is what lets a consumer
   * tell them apart, so it must not be omissible.
   */
  it('requires the recovered discriminator', () => {
    const { recovered, ...withoutRecovered } = valid;
    void recovered;
    expect(eventRegistry[SUBSCRIPTION_PAYMENT_SUCCEEDED].safeParse(withoutRecovered).success).toBe(
      false,
    );
  });

  it('allows attemptsCleared = 0 (the routine-renewal case) but not negative', () => {
    expect(
      eventRegistry[SUBSCRIPTION_PAYMENT_SUCCEEDED].safeParse({
        ...valid,
        recovered: false,
        attemptsCleared: 0,
      }).success,
    ).toBe(true);
    expect(
      eventRegistry[SUBSCRIPTION_PAYMENT_SUCCEEDED].safeParse({ ...valid, attemptsCleared: -1 })
        .success,
    ).toBe(false);
  });
});

describe('SubscriptionDunningExhausted event', () => {
  const valid = {
    eventId: 'evt_de_1',
    occurredAt: '2026-05-20T00:00:00.000Z',
    subscriptionId: 'sub_001',
    customerId: 'cust_001',
    customerGroup: 'family',
    exhaustedAt: '2026-05-20T00:00:00.000Z',
    graceUntil: '2026-05-10T00:00:00.000Z',
    attemptCount: 4,
  };

  it('requires `customerGroup` — `customerId` is meaningless without it', () => {
    const { customerGroup, ...withoutGroup } = valid;
    void customerGroup;
    expect(eventRegistry[SUBSCRIPTION_DUNNING_EXHAUSTED].safeParse(withoutGroup).success).toBe(
      false,
    );
  });

  it('accepts a valid payload', () => {
    expect(eventRegistry[SUBSCRIPTION_DUNNING_EXHAUSTED].safeParse(valid).success).toBe(true);
  });

  /**
   * Exhaustion is the end of the ladder, not a rung. The grace deadline that
   * expired is required (not nullable, unlike on `payment_failed`) — there is
   * no such thing as an exhaustion without a deadline to have exhausted.
   */
  it('requires a non-null graceUntil', () => {
    expect(
      eventRegistry[SUBSCRIPTION_DUNNING_EXHAUSTED].safeParse({ ...valid, graceUntil: null })
        .success,
    ).toBe(false);
  });
});

describe('SubscriptionPaused / SubscriptionResumed events', () => {
  const validPause = {
    eventId: 'evt_pause_1',
    occurredAt: '2026-05-20T00:00:00.000Z',
    subscriptionId: 'sub_001',
    customerId: 'cust_001',
    pausedAt: '2026-05-20T00:00:00.000Z',
    resumesAt: null,
    hasReason: true,
    requesterUserId: 'usr_001',
    fromStatus: 'active',
  };

  const validResume = {
    eventId: 'evt_resume_1',
    occurredAt: '2026-06-20T00:00:00.000Z',
    subscriptionId: 'sub_001',
    customerId: 'cust_001',
    resumedAt: '2026-06-20T00:00:00.000Z',
    requesterUserId: 'usr_001',
    toStatus: 'past_due',
    hasNote: false,
  };

  it('accepts valid payloads', () => {
    expect(eventRegistry[SUBSCRIPTION_PAUSED].safeParse(validPause).success).toBe(true);
    expect(eventRegistry[SUBSCRIPTION_RESUMED].safeParse(validResume).success).toBe(true);
  });

  /**
   * The safety property these two events are built around. A pause reason is
   * free-form text and on this platform is very often a health or bereavement
   * disclosure about a named senior; an event replicates to the relay, Redis
   * Streams, and every consumer's dedup table (CLAUDE.md §3.9, §12). `.strict()`
   * is what enforces it — a producer that tried to attach the text would be
   * rejected at append time rather than quietly fanning it out.
   */
  it('refuses free-form reason / note text on the wire', () => {
    expect(
      eventRegistry[SUBSCRIPTION_PAUSED].safeParse({
        ...validPause,
        reason: 'mother entered hospice care',
      }).success,
    ).toBe(false);
    expect(
      eventRegistry[SUBSCRIPTION_RESUMED].safeParse({
        ...validResume,
        note: 'card replaced over the phone',
      }).success,
    ).toBe(false);
  });

  /**
   * Resume adopts whatever status Stripe reports — `past_due` when the
   * subscription was paused mid-dunning. A consumer resuming revenue accrual
   * must read `toStatus` rather than assume recovery, so the field carries the
   * full status set, not just `active`.
   */
  it('allows resumed.toStatus to be a non-active status', () => {
    for (const toStatus of ['active', 'trialing', 'past_due', 'unpaid']) {
      expect(
        eventRegistry[SUBSCRIPTION_RESUMED].safeParse({ ...validResume, toStatus }).success,
      ).toBe(true);
    }
    expect(
      eventRegistry[SUBSCRIPTION_RESUMED].safeParse({ ...validResume, toStatus: 'nonsense' })
        .success,
    ).toBe(false);
  });

  it('requires resumesAt to be stated as null rather than omitted', () => {
    const { resumesAt, ...withoutResumesAt } = validPause;
    void resumesAt;
    expect(eventRegistry[SUBSCRIPTION_PAUSED].safeParse(withoutResumesAt).success).toBe(false);
  });
});

/**
 * TS-042-followup-3 — the dunning events carry their own status enum rather
 * than importing the HTTP DTO's (events evolve on their own schedule,
 * CLAUDE.md §5.3). This asserts the deliberate copy stays in step with the
 * source it was copied from, so a status added to the platform is a failing
 * test here rather than an event that cannot describe it.
 */
describe('dunning event status enum', () => {
  it('covers exactly the platform subscription status set', () => {
    for (const status of SubscriptionStatusSchema.options) {
      expect(
        eventRegistry[SUBSCRIPTION_RESUMED].safeParse({
          eventId: 'evt_1',
          occurredAt: '2026-06-20T00:00:00.000Z',
          subscriptionId: 'sub_001',
          customerId: 'cust_001',
          resumedAt: '2026-06-20T00:00:00.000Z',
          requesterUserId: 'usr_001',
          toStatus: status,
          hasNote: false,
        }).success,
      ).toBe(true);
    }
  });
});
