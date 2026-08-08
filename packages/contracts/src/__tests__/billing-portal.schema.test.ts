import { describe, expect, it } from 'vitest';

import {
  BillingPortalSessionResponseSchema,
  CreateBillingPortalSessionRequestSchema,
} from '../http/billing-portal.schema';

/**
 * Contract tests for the Billing Portal session DTOs
 * (TS-042-followup-3a3-followup-1).
 *
 * The properties asserted here are the security ones. A portal session
 * hands the holder full billing control over a Stripe customer, so the
 * shape of the request is what stops a caller naming somebody else's.
 */
describe('CreateBillingPortalSessionRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(CreateBillingPortalSessionRequestSchema.safeParse({}).success).toBe(true);
  });

  it('REJECTS a caller-supplied customer id rather than ignoring it', () => {
    // The whole point. A stripped-unknown-keys schema would accept this
    // and drop the field, which reads to the caller as though it worked.
    const parsed = CreateBillingPortalSessionRequestSchema.safeParse({
      customerId: 'cus_someone_else',
    });
    expect(parsed.success).toBe(false);
  });

  it('REJECTS a caller-supplied returnUrl — that would be an open redirect', () => {
    const parsed = CreateBillingPortalSessionRequestSchema.safeParse({
      returnUrl: 'https://phishing.example/login',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a subscriptionId — the granularity the safe shape deliberately drops', () => {
    const parsed = CreateBillingPortalSessionRequestSchema.safeParse({
      subscriptionId: 'sub_local_xyz',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('BillingPortalSessionResponseSchema', () => {
  it('accepts a Stripe portal URL', () => {
    const parsed = BillingPortalSessionResponseSchema.safeParse({
      url: 'https://billing.stripe.com/p/session/live_abc123',
    });
    expect(parsed.success).toBe(true);
  });

  it('requires the url to be a URL', () => {
    expect(BillingPortalSessionResponseSchema.safeParse({ url: 'not-a-url' }).success).toBe(false);
  });

  it('carries the url and nothing else', () => {
    // A DTO that mirrors the upstream object leaks whatever Stripe adds
    // to it next. Pinning the key set is what keeps that from happening
    // by accident — `.strict()` alone only guards the inbound direction.
    expect(Object.keys(BillingPortalSessionResponseSchema.shape)).toEqual(['url']);
  });

  it('rejects Stripe-internal fields leaking through a widened select', () => {
    const parsed = BillingPortalSessionResponseSchema.safeParse({
      url: 'https://billing.stripe.com/p/session/live_abc123',
      customer: 'cus_abc',
      livemode: true,
    });
    expect(parsed.success).toBe(false);
  });
});
