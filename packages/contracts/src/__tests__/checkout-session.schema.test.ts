import { describe, expect, it } from 'vitest';

import {
  CHECKOUT_RETURN_URL_MAX_LENGTH,
  CreateCheckoutSessionRequestSchema,
  CreateCheckoutSessionResponseSchema,
  FinalizeCheckoutSessionRequestSchema,
  GetCheckoutSessionResponseSchema,
  type CreateCheckoutSessionRequest,
  type CreateCheckoutSessionResponse,
  type GetCheckoutSessionResponse,
} from '../http/checkout-session.schema';

const validCreate: CreateCheckoutSessionRequest = {
  planId: 'plan_tier2',
  customerId: 'cust_household_abc',
  customerGroup: 'family',
  customerEmail: 'payer@example.com',
  customerName: 'Avery Family Payer',
  billingInterval: 'monthly',
  successUrl: 'https://app.tasteandsee.com/checkout/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://app.tasteandsee.com/plans',
};

describe('CreateCheckoutSessionRequestSchema', () => {
  it('accepts a valid request and round-trips it unchanged', () => {
    const parsed = CreateCheckoutSessionRequestSchema.parse(validCreate);
    expect(parsed).toEqual(validCreate);
  });

  it('accepts trialDays + couponCode', () => {
    const parsed = CreateCheckoutSessionRequestSchema.parse({
      ...validCreate,
      trialDays: 14,
      couponCode: 'WELCOME10',
    });
    expect(parsed.trialDays).toBe(14);
    expect(parsed.couponCode).toBe('WELCOME10');
  });

  it('rejects unknown fields (`.strict()`)', () => {
    const result = CreateCheckoutSessionRequestSchema.safeParse({
      ...validCreate,
      paymentMethodId: 'pm_xyz',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-http URLs for successUrl', () => {
    const result = CreateCheckoutSessionRequestSchema.safeParse({
      ...validCreate,
      successUrl: 'javascript:alert(1)',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an over-long successUrl', () => {
    const longUrl = `https://app.tasteandsee.com/${'a'.repeat(CHECKOUT_RETURN_URL_MAX_LENGTH)}`;
    const result = CreateCheckoutSessionRequestSchema.safeParse({
      ...validCreate,
      successUrl: longUrl,
    });
    expect(result.success).toBe(false);
  });

  it('rejects trialDays above the bound', () => {
    const result = CreateCheckoutSessionRequestSchema.safeParse({
      ...validCreate,
      trialDays: 91,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed email', () => {
    const result = CreateCheckoutSessionRequestSchema.safeParse({
      ...validCreate,
      customerEmail: 'not-an-email',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a customerGroup not in the plan enum', () => {
    const result = CreateCheckoutSessionRequestSchema.safeParse({
      ...validCreate,
      customerGroup: 'partner',
    });
    expect(result.success).toBe(false);
  });

  it('infers a TS type that matches the schema shape', () => {
    const compileTimeCheck: CreateCheckoutSessionRequest = validCreate;
    expect(compileTimeCheck).toBeDefined();
  });
});

describe('CreateCheckoutSessionResponseSchema', () => {
  const validResponse: CreateCheckoutSessionResponse = {
    id: 'cs_test_a1b2c3d4',
    url: 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3d4',
    expiresAt: '2026-05-18T00:00:00.000Z',
    status: 'open',
  };

  it('accepts a freshly-created session', () => {
    const parsed = CreateCheckoutSessionResponseSchema.parse(validResponse);
    expect(parsed).toEqual(validResponse);
  });

  it('rejects unknown fields', () => {
    expect(
      CreateCheckoutSessionResponseSchema.safeParse({ ...validResponse, extra: 1 }).success,
    ).toBe(false);
  });

  it('rejects an invalid status', () => {
    expect(
      CreateCheckoutSessionResponseSchema.safeParse({
        ...validResponse,
        status: 'pending',
      }).success,
    ).toBe(false);
  });
});

describe('GetCheckoutSessionResponseSchema', () => {
  const openSession: GetCheckoutSessionResponse = {
    id: 'cs_test_a1b2c3d4',
    url: 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3d4',
    expiresAt: '2026-05-18T00:00:00.000Z',
    status: 'open',
    stripeSubscriptionId: null,
    subscriptionId: null,
    customerEmail: null,
  };

  it('accepts an open session with null completion fields', () => {
    const parsed = GetCheckoutSessionResponseSchema.parse(openSession);
    expect(parsed).toEqual(openSession);
  });

  it('accepts a completed session with populated subscription ids', () => {
    const completed: GetCheckoutSessionResponse = {
      ...openSession,
      status: 'complete',
      stripeSubscriptionId: 'sub_1ABcDef',
      subscriptionId: 'sub_local_xyz',
      customerEmail: 'payer@example.com',
    };
    expect(GetCheckoutSessionResponseSchema.parse(completed)).toEqual(completed);
  });

  it('accepts a completed session before finalize has run (subscriptionId null)', () => {
    const completedNotFinalized: GetCheckoutSessionResponse = {
      ...openSession,
      status: 'complete',
      stripeSubscriptionId: 'sub_1ABcDef',
      subscriptionId: null,
      customerEmail: 'payer@example.com',
    };
    expect(GetCheckoutSessionResponseSchema.parse(completedNotFinalized)).toEqual(
      completedNotFinalized,
    );
  });

  it('rejects unknown fields', () => {
    expect(GetCheckoutSessionResponseSchema.safeParse({ ...openSession, extra: 'x' }).success).toBe(
      false,
    );
  });
});

describe('FinalizeCheckoutSessionRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(FinalizeCheckoutSessionRequestSchema.parse({})).toEqual({});
  });

  it('rejects any extra fields', () => {
    expect(FinalizeCheckoutSessionRequestSchema.safeParse({ note: 'hi' }).success).toBe(false);
  });
});
