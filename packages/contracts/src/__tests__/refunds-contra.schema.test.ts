import { describe, expect, it } from 'vitest';

import {
  ApplyBookingRefundRequestSchema,
  ApplyBookingRefundResponseSchema,
  ApplyCouponRedemptionRequestSchema,
  ApplyCouponRedemptionResponseSchema,
  ApplySubscriptionRefundRequestSchema,
  ApplySubscriptionRefundResponseSchema,
  COUPON_CONTRA_AMOUNT_MAX_MINOR,
  REFUND_AMOUNT_MAX_MINOR,
} from '../http/refunds-contra.schema';

describe('ApplyCouponRedemptionRequestSchema', () => {
  const valid = {
    couponRedemptionId: 'cred_abc',
    subscriptionId: 'sub_abc',
    customerId: 'cust_abc',
    customerGroup: 'family' as const,
    planCode: 'family.tier2',
    discountAmountMinor: 5_000,
    occurredAt: '2026-05-12T10:00:00.000Z',
    sourceEventId: 'evt_coupon.redeemed_cred_abc',
  };

  it('accepts a well-formed coupon redemption body', () => {
    const parsed = ApplyCouponRedemptionRequestSchema.parse(valid);
    expect(parsed.discountAmountMinor).toBe(5_000);
    expect(parsed.currency).toBe('USD');
    expect(parsed.planCode).toBe('family.tier2');
  });

  it('rejects discount amount at 0', () => {
    expect(
      ApplyCouponRedemptionRequestSchema.safeParse({
        ...valid,
        discountAmountMinor: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects discount exceeding the cap', () => {
    expect(
      ApplyCouponRedemptionRequestSchema.safeParse({
        ...valid,
        discountAmountMinor: COUPON_CONTRA_AMOUNT_MAX_MINOR + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed plan code', () => {
    expect(
      ApplyCouponRedemptionRequestSchema.safeParse({
        ...valid,
        planCode: 'family',
      }).success,
    ).toBe(false);
    expect(
      ApplyCouponRedemptionRequestSchema.safeParse({
        ...valid,
        planCode: 'Family.Tier2',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(
      ApplyCouponRedemptionRequestSchema.safeParse({
        ...valid,
        unexpected: 'field',
      }).success,
    ).toBe(false);
  });
});

describe('ApplyCouponRedemptionResponseSchema', () => {
  it('round-trips the response shape', () => {
    const response = {
      journalId: 'jrnl_abc',
      couponRedemptionId: 'cred_abc',
      subscriptionId: 'sub_abc',
      planCode: 'family.tier2',
      discountAmountMinor: 5_000,
      currency: 'USD' as const,
      result: 'created' as const,
    };
    expect(ApplyCouponRedemptionResponseSchema.parse(response)).toEqual(response);
  });

  it('accepts idempotent_replay as result', () => {
    const response = {
      journalId: 'jrnl_abc',
      couponRedemptionId: 'cred_abc',
      subscriptionId: 'sub_abc',
      planCode: 'family.tier2',
      discountAmountMinor: 5_000,
      currency: 'USD' as const,
      result: 'idempotent_replay' as const,
    };
    expect(ApplyCouponRedemptionResponseSchema.parse(response).result).toBe('idempotent_replay');
  });
});

describe('ApplySubscriptionRefundRequestSchema', () => {
  const valid = {
    subscriptionId: 'sub_abc',
    customerId: 'cust_abc',
    customerGroup: 'family' as const,
    planCode: 'family.tier2',
    refundAmountMinor: 9_900,
    occurredAt: '2026-05-12T11:00:00.000Z',
    sourceEventId: 'evt_subscription.refunded_sub_abc',
  };

  it('accepts a well-formed subscription refund', () => {
    const parsed = ApplySubscriptionRefundRequestSchema.parse(valid);
    expect(parsed.refundAmountMinor).toBe(9_900);
    expect(parsed.currency).toBe('USD');
  });

  it('accepts an optional originalActivationJournalId back-pointer', () => {
    const parsed = ApplySubscriptionRefundRequestSchema.parse({
      ...valid,
      originalActivationJournalId: 'jrnl_xyz',
    });
    expect(parsed.originalActivationJournalId).toBe('jrnl_xyz');
  });

  it('rejects refund amount at 0', () => {
    expect(
      ApplySubscriptionRefundRequestSchema.safeParse({
        ...valid,
        refundAmountMinor: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects refund exceeding the cap', () => {
    expect(
      ApplySubscriptionRefundRequestSchema.safeParse({
        ...valid,
        refundAmountMinor: REFUND_AMOUNT_MAX_MINOR + 1,
      }).success,
    ).toBe(false);
  });
});

describe('ApplySubscriptionRefundResponseSchema', () => {
  it('round-trips the response shape', () => {
    const response = {
      journalId: 'jrnl_abc',
      subscriptionId: 'sub_abc',
      planCode: 'family.tier2',
      refundAmountMinor: 9_900,
      currency: 'USD' as const,
      result: 'created' as const,
    };
    expect(ApplySubscriptionRefundResponseSchema.parse(response)).toEqual(response);
  });
});

describe('ApplyBookingRefundRequestSchema', () => {
  const valid = {
    bookingId: 'bk_abc',
    providerId: 'prv_abc',
    householdId: 'hh_abc',
    refundAmountMinor: 15_000,
    providerPortionMinor: 12_000,
    marketplacePortionMinor: 3_000,
    commissionRateBps: 2000,
    occurredAt: '2026-05-12T12:00:00.000Z',
    sourceEventId: 'evt_booking.refunded_bk_abc',
  };

  it('accepts the canonical full-refund booking', () => {
    const parsed = ApplyBookingRefundRequestSchema.parse(valid);
    expect(parsed.refundAmountMinor).toBe(15_000);
    expect(parsed.providerPortionMinor).toBe(12_000);
    expect(parsed.marketplacePortionMinor).toBe(3_000);
    expect(parsed.currency).toBe('USD');
  });

  it('accepts a refund with zero provider portion (platform eats it)', () => {
    const parsed = ApplyBookingRefundRequestSchema.parse({
      ...valid,
      providerPortionMinor: 0,
      marketplacePortionMinor: valid.refundAmountMinor,
    });
    expect(parsed.providerPortionMinor).toBe(0);
  });

  it('accepts a refund with zero marketplace portion (full clawback)', () => {
    const parsed = ApplyBookingRefundRequestSchema.parse({
      ...valid,
      providerPortionMinor: valid.refundAmountMinor,
      marketplacePortionMinor: 0,
    });
    expect(parsed.marketplacePortionMinor).toBe(0);
  });

  it('rejects when provider + marketplace != gross', () => {
    expect(
      ApplyBookingRefundRequestSchema.safeParse({
        ...valid,
        providerPortionMinor: 11_999,
        marketplacePortionMinor: 3_000,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(
      ApplyBookingRefundRequestSchema.safeParse({
        ...valid,
        unexpected: 'field',
      }).success,
    ).toBe(false);
  });

  it('rejects fractional commission bps', () => {
    expect(
      ApplyBookingRefundRequestSchema.safeParse({
        ...valid,
        commissionRateBps: 1500.5,
      }).success,
    ).toBe(false);
  });
});

describe('ApplyBookingRefundResponseSchema', () => {
  it('round-trips the response shape', () => {
    const response = {
      journalId: 'jrnl_abc',
      bookingId: 'bk_abc',
      providerId: 'prv_abc',
      refundAmountMinor: 15_000,
      providerPortionMinor: 12_000,
      marketplacePortionMinor: 3_000,
      commissionRateBps: 2000,
      currency: 'USD' as const,
      runningPayableMinor: 8_000,
      result: 'created' as const,
    };
    expect(ApplyBookingRefundResponseSchema.parse(response)).toEqual(response);
  });

  it('accepts a negative running payable (clawback)', () => {
    const response = {
      journalId: 'jrnl_abc',
      bookingId: 'bk_abc',
      providerId: 'prv_abc',
      refundAmountMinor: 15_000,
      providerPortionMinor: 12_000,
      marketplacePortionMinor: 3_000,
      commissionRateBps: 2000,
      currency: 'USD' as const,
      runningPayableMinor: -5_000,
      result: 'created' as const,
    };
    expect(ApplyBookingRefundResponseSchema.parse(response).runningPayableMinor).toBe(-5_000);
  });
});
