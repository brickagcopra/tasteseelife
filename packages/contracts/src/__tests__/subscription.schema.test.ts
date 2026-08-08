import { describe, expect, it } from 'vitest';

import {
  BillingIntervalSchema,
  CancelSubscriptionRequestSchema,
  CreateSubscriptionRequestSchema,
  PAUSE_REASON_MAX_LENGTH,
  PatchSubscriptionRequestSchema,
  PauseSubscriptionRequestSchema,
  ResumeSubscriptionRequestSchema,
  SUBSCRIPTION_TRIAL_DAYS_MAX,
  SubscriptionCancelReasonSchema,
  SubscriptionResponseSchema,
  SubscriptionStatusSchema,
  type CreateSubscriptionRequest,
  type SubscriptionResponse,
} from '../http/subscription.schema';

const validCreate: CreateSubscriptionRequest = {
  planId: 'plan_companion',
  customerId: 'hh_123',
  customerGroup: 'family',
  billingInterval: 'monthly',
  paymentMethodId: 'pm_card_visa',
  customerEmail: 'parent@example.com',
};

describe('CreateSubscriptionRequestSchema', () => {
  it('accepts a well-formed create request', () => {
    expect(CreateSubscriptionRequestSchema.parse(validCreate)).toEqual(validCreate);
  });

  it('accepts a trial-only create (no paymentMethodId)', () => {
    const { paymentMethodId: _omit, ...withoutPm } = validCreate;
    void _omit;
    const trialOnly = { ...withoutPm, trialDays: 14 };
    const parsed = CreateSubscriptionRequestSchema.parse(trialOnly);
    expect(parsed.trialDays).toBe(14);
  });

  it('rejects when both paymentMethodId AND trialDays are missing', () => {
    const { paymentMethodId: _omit, ...withoutPm } = validCreate;
    void _omit;
    expect(CreateSubscriptionRequestSchema.safeParse(withoutPm).success).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(CreateSubscriptionRequestSchema.safeParse({ ...validCreate, secret: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects a non-pm_ paymentMethodId', () => {
    expect(
      CreateSubscriptionRequestSchema.safeParse({
        ...validCreate,
        paymentMethodId: 'card_xyz',
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid billingInterval', () => {
    expect(
      CreateSubscriptionRequestSchema.safeParse({
        ...validCreate,
        billingInterval: 'quarterly',
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed customerEmail', () => {
    expect(
      CreateSubscriptionRequestSchema.safeParse({ ...validCreate, customerEmail: 'not-an-email' })
        .success,
    ).toBe(false);
  });

  it('rejects trialDays beyond SUBSCRIPTION_TRIAL_DAYS_MAX', () => {
    expect(
      CreateSubscriptionRequestSchema.safeParse({
        ...validCreate,
        trialDays: SUBSCRIPTION_TRIAL_DAYS_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects negative trialDays', () => {
    expect(
      CreateSubscriptionRequestSchema.safeParse({ ...validCreate, trialDays: -1 }).success,
    ).toBe(false);
  });

  it('rejects fractional trialDays', () => {
    expect(
      CreateSubscriptionRequestSchema.safeParse({ ...validCreate, trialDays: 7.5 }).success,
    ).toBe(false);
  });

  it('rejects an unsupported customerGroup', () => {
    expect(
      CreateSubscriptionRequestSchema.safeParse({ ...validCreate, customerGroup: 'partner' })
        .success,
    ).toBe(false);
  });
});

describe('PatchSubscriptionRequestSchema', () => {
  it('accepts a planId-only patch', () => {
    expect(PatchSubscriptionRequestSchema.parse({ planId: 'plan_companion' })).toEqual({
      planId: 'plan_companion',
    });
  });

  it('accepts a paymentMethodId-only patch', () => {
    expect(PatchSubscriptionRequestSchema.parse({ paymentMethodId: 'pm_new' })).toEqual({
      paymentMethodId: 'pm_new',
    });
  });

  it('accepts a patch with both fields together', () => {
    const both = { planId: 'plan_concierge', paymentMethodId: 'pm_premium' };
    expect(PatchSubscriptionRequestSchema.parse(both)).toEqual(both);
  });

  it('rejects an empty patch', () => {
    expect(PatchSubscriptionRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(PatchSubscriptionRequestSchema.safeParse({ planId: 'p_x', secret: 'y' }).success).toBe(
      false,
    );
  });

  it('rejects a non-pm_ paymentMethodId', () => {
    expect(PatchSubscriptionRequestSchema.safeParse({ paymentMethodId: 'card_xyz' }).success).toBe(
      false,
    );
  });
});

describe('CancelSubscriptionRequestSchema', () => {
  it('applies defaults when called with an empty body', () => {
    const parsed = CancelSubscriptionRequestSchema.parse({});
    expect(parsed.cancelAtPeriodEnd).toBe(true);
    expect(parsed.reason).toBe('customer_request');
  });

  it('accepts an immediate-cancel request with an admin note', () => {
    const body = {
      cancelAtPeriodEnd: false,
      reason: 'admin_action' as const,
      note: 'fraud confirmed via T&S review #42',
    };
    expect(CancelSubscriptionRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects a note exceeding 2000 chars', () => {
    expect(CancelSubscriptionRequestSchema.safeParse({ note: 'x'.repeat(2001) }).success).toBe(
      false,
    );
  });

  it('rejects an unknown cancel reason', () => {
    expect(CancelSubscriptionRequestSchema.safeParse({ reason: 'bored' }).success).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(CancelSubscriptionRequestSchema.safeParse({ secret: 'x' }).success).toBe(false);
  });
});

const validResponse: SubscriptionResponse = {
  id: 'sub_internal_001',
  stripeSubscriptionId: 'sub_stripe_xyz',
  stripeCustomerId: 'cus_stripe_abc',
  customerId: 'hh_123',
  customerGroup: 'family',
  planId: 'plan_companion',
  planCode: 'family.tier2',
  status: 'active',
  billingInterval: 'monthly',
  unitPriceUsdMinor: 19900,
  currency: 'USD',
  currentPeriodStart: '2026-05-10T00:00:00.000Z',
  currentPeriodEnd: '2026-06-10T00:00:00.000Z',
  trialEnd: null,
  cancelAtPeriodEnd: false,
  cancelReason: null,
  canceledAt: null,
  dunningAttempts: 0,
  dunningLastAttemptAt: null,
  dunningGraceUntil: null,
  pauseCollectionStartedAt: null,
  pauseCollectionResumesAt: null,
  pauseReason: null,
  createdAt: '2026-05-10T00:00:00.000Z',
  updatedAt: '2026-05-10T00:00:00.000Z',
};

describe('SubscriptionResponseSchema', () => {
  it('round-trips a valid response unchanged', () => {
    expect(SubscriptionResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it('accepts a canceled response with a canceled-at timestamp', () => {
    const canceled: SubscriptionResponse = {
      ...validResponse,
      status: 'canceled',
      cancelAtPeriodEnd: true,
      cancelReason: 'customer_request',
      canceledAt: '2026-06-09T12:00:00.000Z',
    };
    expect(SubscriptionResponseSchema.parse(canceled)).toEqual(canceled);
  });

  it('accepts a trialing response with a non-null trialEnd', () => {
    const trialing: SubscriptionResponse = {
      ...validResponse,
      status: 'trialing',
      trialEnd: '2026-05-24T00:00:00.000Z',
    };
    expect(SubscriptionResponseSchema.parse(trialing)).toEqual(trialing);
  });

  it('rejects negative unitPriceUsdMinor', () => {
    expect(
      SubscriptionResponseSchema.safeParse({ ...validResponse, unitPriceUsdMinor: -1 }).success,
    ).toBe(false);
  });

  it('rejects fractional unitPriceUsdMinor (integer minor units only)', () => {
    expect(
      SubscriptionResponseSchema.safeParse({ ...validResponse, unitPriceUsdMinor: 99.5 }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(SubscriptionResponseSchema.safeParse({ ...validResponse, secret: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects an invalid status', () => {
    expect(
      SubscriptionResponseSchema.safeParse({ ...validResponse, status: 'magical' }).success,
    ).toBe(false);
  });

  it('requires datetime ISO strings for the period fields', () => {
    expect(
      SubscriptionResponseSchema.safeParse({ ...validResponse, currentPeriodStart: '2026-05-10' })
        .success,
    ).toBe(false);
  });
});

describe('SubscriptionResponseSchema — dunning + pause fields (TS-042)', () => {
  it('accepts a row in dunning (past_due + non-null dunning fields)', () => {
    const dunning: SubscriptionResponse = {
      ...validResponse,
      status: 'past_due',
      dunningAttempts: 2,
      dunningLastAttemptAt: '2026-05-12T12:00:00.000Z',
      dunningGraceUntil: '2026-06-02T00:00:00.000Z',
    };
    expect(SubscriptionResponseSchema.parse(dunning)).toEqual(dunning);
  });

  it('accepts a paused row with non-null pause fields', () => {
    const paused: SubscriptionResponse = {
      ...validResponse,
      status: 'paused',
      pauseCollectionStartedAt: '2026-05-12T12:00:00.000Z',
      pauseCollectionResumesAt: '2026-06-12T00:00:00.000Z',
      pauseReason: 'customer travel hold',
    };
    expect(SubscriptionResponseSchema.parse(paused)).toEqual(paused);
  });

  it('rejects negative dunningAttempts', () => {
    expect(
      SubscriptionResponseSchema.safeParse({ ...validResponse, dunningAttempts: -1 }).success,
    ).toBe(false);
  });

  it('rejects fractional dunningAttempts (integer count only)', () => {
    expect(
      SubscriptionResponseSchema.safeParse({ ...validResponse, dunningAttempts: 1.5 }).success,
    ).toBe(false);
  });

  it('requires a datetime ISO for non-null dunningGraceUntil', () => {
    expect(
      SubscriptionResponseSchema.safeParse({
        ...validResponse,
        dunningGraceUntil: '2026-06-02',
      }).success,
    ).toBe(false);
  });

  it('omitting the new fields entirely is a parse failure (server always sends them)', () => {
    const {
      dunningAttempts: _omit1,
      dunningLastAttemptAt: _omit2,
      dunningGraceUntil: _omit3,
      pauseCollectionStartedAt: _omit4,
      pauseCollectionResumesAt: _omit5,
      pauseReason: _omit6,
      ...legacy
    } = validResponse;
    void _omit1;
    void _omit2;
    void _omit3;
    void _omit4;
    void _omit5;
    void _omit6;
    expect(SubscriptionResponseSchema.safeParse(legacy).success).toBe(false);
  });
});

describe('PauseSubscriptionRequestSchema', () => {
  it('accepts an empty body (indefinite pause, no reason)', () => {
    expect(PauseSubscriptionRequestSchema.parse({})).toEqual({});
  });

  it('accepts a resumesAt + reason pair', () => {
    const body = {
      resumesAt: '2026-06-12T00:00:00.000Z',
      reason: 'customer requested 30-day travel hold',
    };
    expect(PauseSubscriptionRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects a malformed resumesAt', () => {
    expect(PauseSubscriptionRequestSchema.safeParse({ resumesAt: '2026-06-12' }).success).toBe(
      false,
    );
  });

  it('rejects a reason longer than PAUSE_REASON_MAX_LENGTH', () => {
    expect(
      PauseSubscriptionRequestSchema.safeParse({
        reason: 'x'.repeat(PAUSE_REASON_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects an empty-string reason (min 1 char)', () => {
    expect(PauseSubscriptionRequestSchema.safeParse({ reason: '' }).success).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(PauseSubscriptionRequestSchema.safeParse({ secret: 'x' }).success).toBe(false);
  });
});

describe('ResumeSubscriptionRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(ResumeSubscriptionRequestSchema.parse({})).toEqual({});
  });

  it('accepts an admin note', () => {
    expect(ResumeSubscriptionRequestSchema.parse({ note: 'pay-method updated' })).toEqual({
      note: 'pay-method updated',
    });
  });

  it('rejects a note longer than 2000 chars', () => {
    expect(ResumeSubscriptionRequestSchema.safeParse({ note: 'x'.repeat(2001) }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(ResumeSubscriptionRequestSchema.safeParse({ secret: 'x' }).success).toBe(false);
  });
});

describe('Enum schemas', () => {
  it('SubscriptionStatusSchema accepts every documented value', () => {
    const all = [
      'incomplete',
      'incomplete_expired',
      'trialing',
      'active',
      'past_due',
      'unpaid',
      'canceled',
      'paused',
    ] as const;
    for (const status of all) {
      expect(SubscriptionStatusSchema.parse(status)).toBe(status);
    }
  });

  it('BillingIntervalSchema accepts monthly + annual', () => {
    expect(BillingIntervalSchema.parse('monthly')).toBe('monthly');
    expect(BillingIntervalSchema.parse('annual')).toBe('annual');
    expect(BillingIntervalSchema.safeParse('quarterly').success).toBe(false);
  });

  it('SubscriptionCancelReasonSchema covers the documented set', () => {
    const all = [
      'customer_request',
      'payment_failure',
      'fraud',
      'admin_action',
      'partner_termination',
    ] as const;
    for (const reason of all) {
      expect(SubscriptionCancelReasonSchema.parse(reason)).toBe(reason);
    }
  });
});
