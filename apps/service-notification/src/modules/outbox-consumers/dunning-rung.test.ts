import {
  BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE,
  BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_VARIABLE_NAMES,
  BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_CODE,
  BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_VARIABLE_NAMES,
  BILLING_PAYMENT_RECOVERED_TEMPLATE_CODE,
  BILLING_SERVICE_PAUSED_TEMPLATE_CODE,
  type SubscriptionDunningExhausted,
  type SubscriptionPaymentFailed,
  type SubscriptionPaymentSucceeded,
} from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import {
  dunningIdempotencyKey,
  formatTemplateDate,
  rungForDunningExhausted,
  rungForPaymentFailed,
  rungForPaymentSucceeded,
} from './dunning-rung';

const config = { appName: 'Taste & See', billingUrl: 'https://app.example.com/billing/invoices' };

function failedEvent(
  overrides: Partial<SubscriptionPaymentFailed> = {},
): SubscriptionPaymentFailed {
  return {
    eventId: 'evt_1',
    occurredAt: '2026-05-07T12:00:00.000Z',
    subscriptionId: 'sub_1',
    customerId: 'hh_1',
    customerGroup: 'family',
    attemptCount: 1,
    attemptedAt: '2026-05-07T12:00:00.000Z',
    graceUntil: '2026-05-28T12:00:00.000Z',
    fromStatus: 'active',
    ...overrides,
  };
}

describe('formatTemplateDate', () => {
  it('renders a human en-US date in UTC', () => {
    expect(formatTemplateDate('2026-05-28T12:00:00.000Z')).toBe('May 28, 2026');
  });

  it('pins UTC so two replicas in different regions agree on the deadline', () => {
    // 00:30 UTC on the 14th is still the 13th in US-Pacific. A pod-local
    // formatter would give two families the same event and two deadlines.
    expect(formatTemplateDate('2026-05-14T00:30:00.000Z')).toBe('May 14, 2026');
  });
});

describe('rungForPaymentFailed', () => {
  it('sends the reassuring first-failure rung on attempt 1', () => {
    const rung = rungForPaymentFailed(failedEvent({ attemptCount: 1 }), config);
    expect(rung.kind).toBe('send');
    if (rung.kind !== 'send') return;
    expect(rung.templateCode).toBe(BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE);
  });

  it('escalates on every later attempt', () => {
    for (const attemptCount of [2, 3, 9]) {
      const rung = rungForPaymentFailed(failedEvent({ attemptCount }), config);
      expect(rung.kind).toBe('send');
      if (rung.kind !== 'send') return;
      expect(rung.templateCode, `attempt ${attemptCount}`).toBe(
        BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_CODE,
      );
    }
  });

  it('supplies exactly the variables each rung declares — no more, no fewer', () => {
    // The render endpoint rejects a missing required variable AND an unknown
    // one, so a mismatch either way is a 400 on an email a family is owed.
    const first = rungForPaymentFailed(failedEvent({ attemptCount: 1 }), config);
    const retry = rungForPaymentFailed(failedEvent({ attemptCount: 2 }), config);
    if (first.kind !== 'send' || retry.kind !== 'send') throw new Error('expected sends');

    expect(Object.keys(first.variables).sort()).toEqual(
      [...BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_VARIABLE_NAMES].sort(),
    );
    expect(Object.keys(retry.variables).sort()).toEqual(
      [...BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_VARIABLE_NAMES].sort(),
    );
  });

  it('gates a null graceUntil to false + empty string, never a placeholder date', () => {
    const rung = rungForPaymentFailed(failedEvent({ graceUntil: null }), config);
    if (rung.kind !== 'send') throw new Error('expected send');
    expect(rung.variables.hasGraceWindow).toBe(false);
    expect(rung.variables.graceUntilLabel).toBe('');
  });

  it('gates an absent nextAttemptAt the same way', () => {
    const rung = rungForPaymentFailed(failedEvent(), config);
    if (rung.kind !== 'send') throw new Error('expected send');
    expect(rung.variables.hasNextAttempt).toBe(false);
    expect(rung.variables.nextAttemptLabel).toBe('');
  });

  it('renders both labels when the event carries both instants', () => {
    const rung = rungForPaymentFailed(
      failedEvent({ nextAttemptAt: '2026-05-10T12:00:00.000Z' }),
      config,
    );
    if (rung.kind !== 'send') throw new Error('expected send');
    expect(rung.variables.hasGraceWindow).toBe(true);
    expect(rung.variables.graceUntilLabel).toBe('May 28, 2026');
    expect(rung.variables.hasNextAttempt).toBe(true);
    expect(rung.variables.nextAttemptLabel).toBe('May 10, 2026');
  });

  it('never puts the attempt count in the variables it hands the template', () => {
    const rung = rungForPaymentFailed(failedEvent({ attemptCount: 4 }), config);
    if (rung.kind !== 'send') throw new Error('expected send');
    expect(Object.keys(rung.variables)).not.toContain('attemptCount');
    expect(Object.values(rung.variables)).not.toContain(4);
  });
});

describe('rungForPaymentSucceeded', () => {
  const base: SubscriptionPaymentSucceeded = {
    eventId: 'evt_2',
    occurredAt: '2026-05-20T09:00:00.000Z',
    subscriptionId: 'sub_1',
    customerId: 'hh_1',
    customerGroup: 'family',
    succeededAt: '2026-05-20T09:00:00.000Z',
    recovered: true,
    fromStatus: 'past_due',
    toStatus: 'active',
    attemptsCleared: 3,
  };

  it('sends the recovery rung when the payment rescued a past_due subscription', () => {
    const rung = rungForPaymentSucceeded(base, config);
    expect(rung.kind).toBe('send');
    if (rung.kind !== 'send') return;
    expect(rung.templateCode).toBe(BILLING_PAYMENT_RECOVERED_TEMPLATE_CODE);
  });

  it('SENDS NOTHING on a routine renewal', () => {
    // The single loudest mistake this ladder can make: `recovered === false`
    // is an ordinary monthly charge, and mailing "you're all set" for it
    // would be a monthly email to every paying customer telling them they
    // had a problem they never had.
    const rung = rungForPaymentSucceeded(
      { ...base, recovered: false, fromStatus: 'active', toStatus: 'active', attemptsCleared: 0 },
      config,
    );
    expect(rung.kind).toBe('skip');
    if (rung.kind !== 'skip') return;
    expect(rung.reason).toBe('routine_renewal');
  });
});

describe('rungForDunningExhausted', () => {
  const event: SubscriptionDunningExhausted = {
    eventId: 'evt_3',
    occurredAt: '2026-05-28T12:00:00.000Z',
    subscriptionId: 'sub_1',
    customerId: 'hh_1',
    customerGroup: 'family',
    exhaustedAt: '2026-05-28T12:00:00.000Z',
    graceUntil: '2026-05-28T00:00:00.000Z',
    attemptCount: 4,
  };

  it('always sends the paused rung', () => {
    const rung = rungForDunningExhausted(event, config);
    expect(rung.kind).toBe('send');
    if (rung.kind !== 'send') return;
    expect(rung.templateCode).toBe(BILLING_SERVICE_PAUSED_TEMPLATE_CODE);
  });

  it('carries no grace-window variable — the window has already closed', () => {
    const rung = rungForDunningExhausted(event, config);
    if (rung.kind !== 'send') throw new Error('expected send');
    expect(Object.keys(rung.variables)).toEqual(['appName', 'billingUrl']);
  });
});

describe('dunningIdempotencyKey', () => {
  it('is per-recipient, not per-event', () => {
    // One event fans out to every payer in the household. An event-only key
    // would let the first payer's dispatch suppress the second's.
    expect(dunningIdempotencyKey('evt_1', 'usr_a')).not.toBe(
      dunningIdempotencyKey('evt_1', 'usr_b'),
    );
  });

  it('is stable across redeliveries of the same event', () => {
    expect(dunningIdempotencyKey('evt_1', 'usr_a')).toBe(dunningIdempotencyKey('evt_1', 'usr_a'));
  });
});
