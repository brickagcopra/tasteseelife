import { describe, expect, it } from 'vitest';

import {
  type Plan,
  type PlansListResponse,
  PlanSchema,
  PlansListResponseSchema,
} from '../http/plan.schema';

const validPlan: Plan = {
  id: 'plan_essential',
  code: 'family.tier1',
  name: 'Essential',
  description: 'Base mass-market membership for families and seniors.',
  customerGroup: 'family',
  monthlyPriceUsdMinor: 2900,
  annualPriceUsdMinor: 29000,
  currency: 'USD',
  features: ['App access', 'Wellness resources', 'Family dashboard'],
  active: true,
  createdAt: '2026-05-07T00:00:00.000Z',
  updatedAt: '2026-05-07T00:00:00.000Z',
};

describe('PlanSchema', () => {
  it('accepts a valid plan and round-trips it unchanged', () => {
    const parsed = PlanSchema.parse(validPlan);
    expect(parsed).toEqual(validPlan);
  });

  it('defaults `currency` to USD when omitted from input', () => {
    const { currency, ...withoutCurrency } = validPlan;
    void currency;
    const parsed = PlanSchema.parse(withoutCurrency);
    expect(parsed.currency).toBe('USD');
  });

  it('rejects unknown fields (`.strict()`)', () => {
    const result = PlanSchema.safeParse({ ...validPlan, secretField: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects negative prices', () => {
    expect(PlanSchema.safeParse({ ...validPlan, monthlyPriceUsdMinor: -1 }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...validPlan, annualPriceUsdMinor: -1 }).success).toBe(false);
  });

  it('rejects fractional prices (integer minor units only)', () => {
    expect(PlanSchema.safeParse({ ...validPlan, monthlyPriceUsdMinor: 29.5 }).success).toBe(false);
  });

  it('rejects an unsupported currency', () => {
    expect(PlanSchema.safeParse({ ...validPlan, currency: 'EUR' }).success).toBe(false);
  });

  it('rejects an invalid customer group', () => {
    expect(PlanSchema.safeParse({ ...validPlan, customerGroup: 'partner' }).success).toBe(false);
  });

  it('rejects a malformed plan code (must match lower-case dot/kebab pattern)', () => {
    expect(PlanSchema.safeParse({ ...validPlan, code: 'Family.Tier1' }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...validPlan, code: '1family.tier1' }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...validPlan, code: 'family/tier1' }).success).toBe(false);
  });

  it('requires ISO datetime strings for createdAt / updatedAt', () => {
    expect(PlanSchema.safeParse({ ...validPlan, createdAt: '2026-05-07' }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...validPlan, updatedAt: 'yesterday' }).success).toBe(false);
  });

  it('infers a Plan TS type that matches the schema shape', () => {
    // Compile-time guard: literal must be assignable to `Plan`. Runtime parse
    // succeeds, so the shape is consistent both ways.
    const sample: Plan = {
      id: 'plan_x',
      code: 'provider.basic',
      name: 'Basic Provider',
      customerGroup: 'provider',
      monthlyPriceUsdMinor: 2900,
      annualPriceUsdMinor: 29000,
      currency: 'USD',
      features: ['Profile listing'],
      active: true,
      createdAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:00.000Z',
    };
    expect(PlanSchema.parse(sample)).toEqual(sample);
  });
});

describe('PlansListResponseSchema', () => {
  it('accepts an empty plans array', () => {
    const result = PlansListResponseSchema.parse({ plans: [] });
    expect(result).toEqual({ plans: [] });
  });

  it('accepts multiple plans and round-trips them unchanged', () => {
    const payload: PlansListResponse = {
      plans: [
        {
          id: 'plan_essential',
          code: 'family.tier1',
          name: 'Essential',
          customerGroup: 'family',
          monthlyPriceUsdMinor: 2900,
          annualPriceUsdMinor: 29000,
          currency: 'USD',
          features: ['App access'],
          active: true,
          createdAt: '2026-05-07T00:00:00.000Z',
          updatedAt: '2026-05-07T00:00:00.000Z',
        },
        {
          id: 'plan_companion',
          code: 'family.tier2',
          name: 'Companion Dining',
          customerGroup: 'family',
          monthlyPriceUsdMinor: 19900,
          annualPriceUsdMinor: 199000,
          currency: 'USD',
          features: ['Monthly companion dining sessions', 'Priority scheduling'],
          active: true,
          createdAt: '2026-05-07T00:00:00.000Z',
          updatedAt: '2026-05-07T00:00:00.000Z',
        },
      ],
    };
    expect(PlansListResponseSchema.parse(payload)).toEqual(payload);
  });

  it('rejects unknown top-level fields (`.strict()`)', () => {
    const result = PlansListResponseSchema.safeParse({
      plans: [],
      nextCursor: 'unexpected-pagination-field',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed nested plan', () => {
    const result = PlansListResponseSchema.safeParse({
      plans: [
        {
          id: 'plan_x',
          code: 'INVALID-UPPER-CASE',
          name: 'X',
          customerGroup: 'family',
          monthlyPriceUsdMinor: 0,
          annualPriceUsdMinor: 0,
          currency: 'USD',
          features: [],
          active: true,
          createdAt: '2026-05-07T00:00:00.000Z',
          updatedAt: '2026-05-07T00:00:00.000Z',
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
