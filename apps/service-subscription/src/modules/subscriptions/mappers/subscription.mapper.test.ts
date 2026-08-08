import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { toSubscriptionResponse, type SubscriptionDtoSource } from './subscription.mapper';

function buildSource(overrides: Partial<SubscriptionDtoSource> = {}): SubscriptionDtoSource {
  return {
    id: 'sub_internal_001',
    stripeSubscriptionId: 'sub_stripe_xyz',
    stripeCustomerId: 'cus_stripe_abc',
    customerId: 'hh_123',
    customerGroup: 'family',
    planId: 'plan_companion',
    planCode: 'family.tier2',
    status: 'active',
    billingInterval: 'monthly',
    unitPriceDecimal: new Decimal('199.00'),
    currency: 'USD',
    currentPeriodStart: new Date('2026-05-10T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-06-10T00:00:00.000Z'),
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
    createdAt: new Date('2026-05-10T00:00:00.000Z'),
    updatedAt: new Date('2026-05-10T00:00:00.000Z'),
    ...overrides,
  };
}

describe('toSubscriptionResponse', () => {
  it('round-trips the full shape', () => {
    const source = buildSource();
    expect(toSubscriptionResponse(source)).toEqual({
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
    });
  });

  it('serialises dunning fields when present', () => {
    const dto = toSubscriptionResponse(
      buildSource({
        status: 'past_due',
        dunningAttempts: 3,
        dunningLastAttemptAt: new Date('2026-05-12T12:00:00.000Z'),
        dunningGraceUntil: new Date('2026-06-02T00:00:00.000Z'),
      }),
    );
    expect(dto.dunningAttempts).toBe(3);
    expect(dto.dunningLastAttemptAt).toBe('2026-05-12T12:00:00.000Z');
    expect(dto.dunningGraceUntil).toBe('2026-06-02T00:00:00.000Z');
  });

  it('serialises pause fields when present', () => {
    const dto = toSubscriptionResponse(
      buildSource({
        status: 'paused',
        pauseCollectionStartedAt: new Date('2026-05-12T12:00:00.000Z'),
        pauseCollectionResumesAt: new Date('2026-06-12T00:00:00.000Z'),
        pauseReason: 'customer travel hold',
      }),
    );
    expect(dto.pauseCollectionStartedAt).toBe('2026-05-12T12:00:00.000Z');
    expect(dto.pauseCollectionResumesAt).toBe('2026-06-12T00:00:00.000Z');
    expect(dto.pauseReason).toBe('customer travel hold');
  });

  it('converts Decimal price to integer USD minor units', () => {
    const dto = toSubscriptionResponse(buildSource({ unitPriceDecimal: new Decimal('29.00') }));
    expect(dto.unitPriceUsdMinor).toBe(2900);
  });

  it('handles fractional cents (e.g. 29.99) via half-even rounding', () => {
    const dto = toSubscriptionResponse(buildSource({ unitPriceDecimal: new Decimal('29.99') }));
    expect(dto.unitPriceUsdMinor).toBe(2999);
  });

  it('serialises trialEnd as an ISO string when non-null', () => {
    const dto = toSubscriptionResponse(
      buildSource({
        status: 'trialing',
        trialEnd: new Date('2026-05-24T00:00:00.000Z'),
      }),
    );
    expect(dto.trialEnd).toBe('2026-05-24T00:00:00.000Z');
  });

  it('serialises canceledAt as an ISO string when non-null', () => {
    const dto = toSubscriptionResponse(
      buildSource({
        status: 'canceled',
        cancelAtPeriodEnd: true,
        cancelReason: 'customer_request',
        canceledAt: new Date('2026-06-09T12:00:00.000Z'),
      }),
    );
    expect(dto.canceledAt).toBe('2026-06-09T12:00:00.000Z');
    expect(dto.cancelReason).toBe('customer_request');
  });

  it('throws on an unsupported currency (defence-in-depth)', () => {
    expect(() => toSubscriptionResponse(buildSource({ currency: 'EUR' }))).toThrow(
      /unsupported currency/,
    );
  });

  it('handles the maximum representable price without precision loss', () => {
    // Decimal(12,2) tops out at 9_999_999_999.99 — minor units fit
    // comfortably inside Number.MAX_SAFE_INTEGER (~9.0e15).
    const dto = toSubscriptionResponse(
      buildSource({ unitPriceDecimal: new Decimal('9999999999.99') }),
    );
    expect(dto.unitPriceUsdMinor).toBe(999_999_999_999);
  });
});
