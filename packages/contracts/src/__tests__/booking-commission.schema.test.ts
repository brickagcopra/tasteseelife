import { describe, expect, it } from 'vitest';

import {
  BOOKING_AMOUNT_MAX_MINOR,
  BOOKING_DESCRIPTION_MAX_LENGTH,
  BOOKING_ID_MAX_LENGTH,
  BookingCommissionRequestSchema,
  BookingCommissionResponseSchema,
  COMMISSION_RATE_BPS_MAX,
  CommissionRateBpsSchema,
  ProviderPayableBalanceResponseSchema,
} from '../http/booking-commission.schema';

describe('CommissionRateBpsSchema', () => {
  it('accepts every PRD §5.4 commission tier', () => {
    expect(CommissionRateBpsSchema.parse(1000)).toBe(1000); // Elite 10%
    expect(CommissionRateBpsSchema.parse(2000)).toBe(2000); // Certified 20%
    expect(CommissionRateBpsSchema.parse(3000)).toBe(3000); // Basic 30%
    expect(CommissionRateBpsSchema.parse(1500)).toBe(1500); // Add-ons 15%
  });

  it('accepts boundary values (0 bps and 10000 bps)', () => {
    expect(CommissionRateBpsSchema.parse(0)).toBe(0);
    expect(CommissionRateBpsSchema.parse(COMMISSION_RATE_BPS_MAX)).toBe(COMMISSION_RATE_BPS_MAX);
  });

  it('rejects out-of-range values', () => {
    expect(CommissionRateBpsSchema.safeParse(-1).success).toBe(false);
    expect(CommissionRateBpsSchema.safeParse(COMMISSION_RATE_BPS_MAX + 1).success).toBe(false);
  });

  it('rejects fractional bps (must be integer)', () => {
    expect(CommissionRateBpsSchema.safeParse(1500.5).success).toBe(false);
  });
});

describe('BookingCommissionRequestSchema', () => {
  const validBody = {
    bookingId: 'bk_abc',
    providerId: 'prv_abc',
    householdId: 'hh_abc',
    grossAmountMinor: 15_000,
    providerAmountMinor: 12_000,
    marketplaceAmountMinor: 3_000,
    commissionRateBps: 2000,
    currency: 'USD' as const,
    completedAt: '2026-05-15T14:30:00.000Z',
    sourceEventId: 'evt_booking.completed_bk_abc',
  };

  it('accepts the canonical PDD Appendix A booking', () => {
    const parsed = BookingCommissionRequestSchema.parse(validBody);
    expect(parsed.grossAmountMinor).toBe(15_000);
    expect(parsed.providerAmountMinor).toBe(12_000);
    expect(parsed.marketplaceAmountMinor).toBe(3_000);
    expect(parsed.commissionRateBps).toBe(2000);
    expect(parsed.currency).toBe('USD');
  });

  it('defaults currency to USD when omitted', () => {
    const { currency: _omit, ...rest } = validBody;
    void _omit;
    const parsed = BookingCommissionRequestSchema.parse(rest);
    expect(parsed.currency).toBe('USD');
  });

  it('enforces gross = provider + marketplace at parse time', () => {
    const parsed = BookingCommissionRequestSchema.safeParse({
      ...validBody,
      grossAmountMinor: 15_000,
      providerAmountMinor: 12_000,
      marketplaceAmountMinor: 2_999,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      expect(flat.fieldErrors['grossAmountMinor']?.[0]).toMatch(/gross/i);
    }
  });

  it('rejects negative provider portion', () => {
    expect(
      BookingCommissionRequestSchema.safeParse({
        ...validBody,
        providerAmountMinor: -1,
        marketplaceAmountMinor: 15_001,
      }).success,
    ).toBe(false);
  });

  it('rejects zero gross (booking must carry value)', () => {
    expect(
      BookingCommissionRequestSchema.safeParse({
        ...validBody,
        grossAmountMinor: 0,
        providerAmountMinor: 0,
        marketplaceAmountMinor: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects fractional minor units (cents must be whole)', () => {
    expect(
      BookingCommissionRequestSchema.safeParse({
        ...validBody,
        grossAmountMinor: 150.5,
      }).success,
    ).toBe(false);
  });

  it('rejects amounts exceeding the Decimal(12,2) envelope', () => {
    expect(
      BookingCommissionRequestSchema.safeParse({
        ...validBody,
        grossAmountMinor: BOOKING_AMOUNT_MAX_MINOR + 1,
      }).success,
    ).toBe(false);
  });

  it('accepts amounts at the envelope boundary', () => {
    const parsed = BookingCommissionRequestSchema.parse({
      ...validBody,
      grossAmountMinor: BOOKING_AMOUNT_MAX_MINOR,
      providerAmountMinor: BOOKING_AMOUNT_MAX_MINOR,
      marketplaceAmountMinor: 0,
    });
    expect(parsed.grossAmountMinor).toBe(BOOKING_AMOUNT_MAX_MINOR);
  });

  it('rejects all-to-marketplace booking with provider = 0 only when sum is wrong', () => {
    // provider=0 is legitimate for free booking promotions where the
    // platform doesn't keep a share either — invariant still holds.
    const parsed = BookingCommissionRequestSchema.parse({
      ...validBody,
      grossAmountMinor: 15_000,
      providerAmountMinor: 0,
      marketplaceAmountMinor: 15_000,
      commissionRateBps: 10_000, // 100% — platform retains everything
    });
    expect(parsed.providerAmountMinor).toBe(0);
  });

  it('rejects unknown fields (.strict())', () => {
    expect(
      BookingCommissionRequestSchema.safeParse({
        ...validBody,
        extra: 'not-allowed',
      }).success,
    ).toBe(false);
  });

  it('rejects malformed completedAt', () => {
    expect(
      BookingCommissionRequestSchema.safeParse({
        ...validBody,
        completedAt: 'not-a-datetime',
      }).success,
    ).toBe(false);
  });

  it('rejects empty sourceEventId', () => {
    expect(
      BookingCommissionRequestSchema.safeParse({
        ...validBody,
        sourceEventId: '',
      }).success,
    ).toBe(false);
  });

  it('rejects description exceeding the cap', () => {
    expect(
      BookingCommissionRequestSchema.safeParse({
        ...validBody,
        description: 'x'.repeat(BOOKING_DESCRIPTION_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects bookingId exceeding the cap', () => {
    expect(
      BookingCommissionRequestSchema.safeParse({
        ...validBody,
        bookingId: 'x'.repeat(BOOKING_ID_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('accepts optional description + context', () => {
    const parsed = BookingCommissionRequestSchema.parse({
      ...validBody,
      description: 'Companion dining at 123 Elm St.',
      context: { invoiceId: 'inv_abc', visitNotes: 'first booking' },
    });
    expect(parsed.description).toBe('Companion dining at 123 Elm St.');
    expect(parsed.context).toEqual({
      invoiceId: 'inv_abc',
      visitNotes: 'first booking',
    });
  });
});

describe('BookingCommissionResponseSchema', () => {
  const validBody = {
    journalId: 'jnl_abc',
    bookingId: 'bk_abc',
    providerId: 'prv_abc',
    grossAmountMinor: 15_000,
    providerAmountMinor: 12_000,
    marketplaceAmountMinor: 3_000,
    commissionRateBps: 2000,
    currency: 'USD' as const,
    runningPayableMinor: 36_000,
    result: 'created' as const,
  };

  it('accepts a created response', () => {
    const parsed = BookingCommissionResponseSchema.parse(validBody);
    expect(parsed.result).toBe('created');
    expect(parsed.runningPayableMinor).toBe(36_000);
  });

  it('accepts an idempotent_replay response', () => {
    const parsed = BookingCommissionResponseSchema.parse({
      ...validBody,
      result: 'idempotent_replay',
    });
    expect(parsed.result).toBe('idempotent_replay');
  });

  it('rejects unknown result variants', () => {
    expect(
      BookingCommissionResponseSchema.safeParse({
        ...validBody,
        result: 'duplicate',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (.strict())', () => {
    expect(
      BookingCommissionResponseSchema.safeParse({
        ...validBody,
        extra: 'no',
      }).success,
    ).toBe(false);
  });

  it('rejects fractional cents on response amounts', () => {
    expect(
      BookingCommissionResponseSchema.safeParse({
        ...validBody,
        runningPayableMinor: 36_000.5,
      }).success,
    ).toBe(false);
  });
});

describe('ProviderPayableBalanceResponseSchema', () => {
  it('accepts a positive balance', () => {
    const parsed = ProviderPayableBalanceResponseSchema.parse({
      providerId: 'prv_abc',
      currency: 'USD',
      amountMinor: 12_000,
      lastUpdatedAt: '2026-05-15T14:30:00.000Z',
    });
    expect(parsed.amountMinor).toBe(12_000);
  });

  it('accepts a zero balance', () => {
    const parsed = ProviderPayableBalanceResponseSchema.parse({
      providerId: 'prv_abc',
      currency: 'USD',
      amountMinor: 0,
      lastUpdatedAt: '2026-05-15T14:30:00.000Z',
    });
    expect(parsed.amountMinor).toBe(0);
  });

  it('accepts a negative balance (refund-after-payout clawback)', () => {
    const parsed = ProviderPayableBalanceResponseSchema.parse({
      providerId: 'prv_abc',
      currency: 'USD',
      amountMinor: -5_000,
      lastUpdatedAt: '2026-05-15T14:30:00.000Z',
    });
    expect(parsed.amountMinor).toBe(-5_000);
  });

  it('rejects fractional minor units', () => {
    expect(
      ProviderPayableBalanceResponseSchema.safeParse({
        providerId: 'prv_abc',
        currency: 'USD',
        amountMinor: 12_000.5,
        lastUpdatedAt: '2026-05-15T14:30:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown currency', () => {
    expect(
      ProviderPayableBalanceResponseSchema.safeParse({
        providerId: 'prv_abc',
        currency: 'EUR',
        amountMinor: 0,
        lastUpdatedAt: '2026-05-15T14:30:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (.strict())', () => {
    expect(
      ProviderPayableBalanceResponseSchema.safeParse({
        providerId: 'prv_abc',
        currency: 'USD',
        amountMinor: 0,
        lastUpdatedAt: '2026-05-15T14:30:00.000Z',
        extra: 'no',
      }).success,
    ).toBe(false);
  });
});
