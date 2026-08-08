import { describe, expect, it } from 'vitest';

import {
  COUPON_AMOUNT_OFF_MAX_MINOR,
  COUPON_CODE_MAX_LENGTH,
  COUPON_DURATION_IN_MONTHS_MAX,
  COUPON_EXTENDED_TRIAL_MAX_DAYS,
  COUPON_NAME_MAX_LENGTH,
  COUPON_PER_CUSTOMER_LIMIT_MAX,
  CouponCodeSchema,
  CouponDurationSchema,
  CouponKindSchema,
  CouponSchema,
  CreateCouponRequestSchema,
  ValidateCouponRequestSchema,
  ValidateCouponResponseSchema,
} from '../http/coupon.schema';

describe('CouponCodeSchema', () => {
  it.each(['FREEMONTH', 'TIER2-OFF', 'PROMO_2026', '999AAA'])('accepts %s', (code) => {
    expect(CouponCodeSchema.safeParse(code).success).toBe(true);
  });

  it.each([
    'ab', // < 3
    'a'.repeat(COUPON_CODE_MAX_LENGTH + 1),
    'lowercase',
    'has space',
    'has.dot',
    'has/slash',
  ])('rejects %s', (code) => {
    expect(CouponCodeSchema.safeParse(code).success).toBe(false);
  });
});

describe('CouponKindSchema', () => {
  it.each(['percent_off', 'amount_off', 'extended_trial'])('accepts %s', (kind) => {
    expect(CouponKindSchema.safeParse(kind).success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(CouponKindSchema.safeParse('free_shipping').success).toBe(false);
  });
});

describe('CouponDurationSchema', () => {
  it.each(['once', 'repeating', 'forever'])('accepts %s', (duration) => {
    expect(CouponDurationSchema.safeParse(duration).success).toBe(true);
  });
});

describe('CreateCouponRequestSchema', () => {
  const base = {
    code: 'FREEMONTH',
    name: 'First month free',
    kind: 'percent_off' as const,
    amount: 100,
    duration: 'once' as const,
  };

  it('accepts a percent_off coupon with amount=100', () => {
    expect(CreateCouponRequestSchema.safeParse(base).success).toBe(true);
  });

  it('rejects a percent_off coupon with amount > 100', () => {
    const result = CreateCouponRequestSchema.safeParse({ ...base, amount: 101 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === 'amount')).toBe(true);
  });

  it('rejects a percent_off coupon with amount = 0', () => {
    const result = CreateCouponRequestSchema.safeParse({ ...base, amount: 0 });
    expect(result.success).toBe(false);
  });

  it('accepts an amount_off coupon within minor-unit bounds', () => {
    const result = CreateCouponRequestSchema.safeParse({
      ...base,
      kind: 'amount_off',
      amount: 2500,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an amount_off coupon above the $1M cap', () => {
    const result = CreateCouponRequestSchema.safeParse({
      ...base,
      kind: 'amount_off',
      amount: COUPON_AMOUNT_OFF_MAX_MINOR + 1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an extended_trial coupon with valid days', () => {
    const result = CreateCouponRequestSchema.safeParse({
      ...base,
      kind: 'extended_trial',
      amount: 14,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an extended_trial coupon above the day cap', () => {
    const result = CreateCouponRequestSchema.safeParse({
      ...base,
      kind: 'extended_trial',
      amount: COUPON_EXTENDED_TRIAL_MAX_DAYS + 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an extended_trial coupon with duration != once', () => {
    const result = CreateCouponRequestSchema.safeParse({
      ...base,
      kind: 'extended_trial',
      amount: 14,
      duration: 'repeating',
      durationInMonths: 3,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === 'duration')).toBe(true);
  });

  it('requires durationInMonths when duration=repeating', () => {
    const result = CreateCouponRequestSchema.safeParse({
      ...base,
      duration: 'repeating',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === 'durationInMonths')).toBe(true);
  });

  it('rejects durationInMonths when duration != repeating', () => {
    const result = CreateCouponRequestSchema.safeParse({
      ...base,
      duration: 'once',
      durationInMonths: 3,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === 'durationInMonths')).toBe(true);
  });

  it('caps durationInMonths', () => {
    const result = CreateCouponRequestSchema.safeParse({
      ...base,
      duration: 'repeating',
      durationInMonths: COUPON_DURATION_IN_MONTHS_MAX + 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields', () => {
    const result = CreateCouponRequestSchema.safeParse({ ...base, sneaky: 'value' });
    expect(result.success).toBe(false);
  });

  it('rejects a name longer than the cap', () => {
    const result = CreateCouponRequestSchema.safeParse({
      ...base,
      name: 'a'.repeat(COUPON_NAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it('caps perCustomerLimit', () => {
    const result = CreateCouponRequestSchema.safeParse({
      ...base,
      perCustomerLimit: COUPON_PER_CUSTOMER_LIMIT_MAX + 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('ValidateCouponRequestSchema', () => {
  const base = {
    code: 'FREEMONTH',
    planId: 'plan_companion',
    customerId: 'hh_123',
    customerGroup: 'family' as const,
  };

  it('accepts a well-formed body', () => {
    expect(ValidateCouponRequestSchema.safeParse(base).success).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(ValidateCouponRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it('rejects a lower-case code', () => {
    expect(ValidateCouponRequestSchema.safeParse({ ...base, code: 'freemonth' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown customerGroup', () => {
    expect(
      ValidateCouponRequestSchema.safeParse({ ...base, customerGroup: 'partner' }).success,
    ).toBe(false);
  });
});

describe('ValidateCouponResponseSchema', () => {
  it('accepts a well-formed body', () => {
    expect(
      ValidateCouponResponseSchema.safeParse({
        couponId: 'cpn_123',
        code: 'FREEMONTH',
        name: 'First month free',
        kind: 'percent_off',
        duration: 'once',
        durationInMonths: null,
        valueAppliedMinor: 19900,
        extendedTrialDays: null,
        currency: 'USD',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(
      ValidateCouponResponseSchema.safeParse({
        couponId: 'cpn_123',
        code: 'FREEMONTH',
        name: 'First month free',
        kind: 'percent_off',
        duration: 'once',
        durationInMonths: null,
        valueAppliedMinor: 19900,
        extendedTrialDays: null,
        currency: 'USD',
        sneaky: 1,
      }).success,
    ).toBe(false);
  });
});

describe('CouponSchema', () => {
  it('accepts an inactive coupon with timesRedeemed > 0', () => {
    const result = CouponSchema.safeParse({
      id: 'cpn_123',
      code: 'OLDPROMO',
      name: 'Old promo',
      kind: 'amount_off',
      amount: 500,
      currency: 'USD',
      duration: 'once',
      durationInMonths: null,
      appliesToPlanIds: [],
      maxRedemptions: 1000,
      timesRedeemed: 42,
      perCustomerLimit: 1,
      firstTimeCustomerOnly: false,
      minSpendMinor: null,
      stackable: false,
      expiresAt: null,
      active: false,
      notes: null,
      createdByUserId: 'usr_admin',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-05-12T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});
