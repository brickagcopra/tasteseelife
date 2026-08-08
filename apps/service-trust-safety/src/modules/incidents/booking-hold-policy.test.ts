import { describe, expect, it } from 'vitest';

import {
  BOOKING_HOLD_SEVERITIES,
  hasHoldSubject,
  isBookingHoldEligible,
} from './booking-hold-policy';

/**
 * TS-304 — the hold predicate.
 *
 * Small surface, but it decides whether a family's meals and companionship
 * stop, so both directions get explicit coverage: the false negative leaves a
 * senior with a provider under investigation, and the false positive
 * interrupts care over a billing dispute.
 */
describe('BOOKING_HOLD_SEVERITIES', () => {
  it('is exactly the two short-SLA grades', () => {
    expect([...BOOKING_HOLD_SEVERITIES]).toEqual(['high', 'critical']);
  });
});

describe('hasHoldSubject', () => {
  it('is true when any single subject is named', () => {
    expect(hasHoldSubject({ providerId: 'prv_1', seniorId: null, householdId: null })).toBe(true);
    expect(hasHoldSubject({ providerId: null, seniorId: 'sen_1', householdId: null })).toBe(true);
    expect(hasHoldSubject({ providerId: null, seniorId: null, householdId: 'hh_1' })).toBe(true);
  });

  it('is false when none is', () => {
    expect(hasHoldSubject({ providerId: null, seniorId: null, householdId: null })).toBe(false);
  });
});

describe('isBookingHoldEligible', () => {
  const subjects = { providerId: 'prv_1', seniorId: 'sen_1', householdId: 'hh_1' };

  it('holds on high and critical', () => {
    expect(isBookingHoldEligible({ severity: 'high', ...subjects })).toBe(true);
    expect(isBookingHoldEligible({ severity: 'critical', ...subjects })).toBe(true);
  });

  it('does NOT hold on medium or low — an everyday report must not stop care', () => {
    expect(isBookingHoldEligible({ severity: 'medium', ...subjects })).toBe(false);
    expect(isBookingHoldEligible({ severity: 'low', ...subjects })).toBe(false);
  });

  it('does NOT hold at any severity when no subject is named', () => {
    for (const severity of ['low', 'medium', 'high', 'critical'] as const) {
      expect(
        isBookingHoldEligible({
          severity,
          providerId: null,
          seniorId: null,
          householdId: null,
        }),
      ).toBe(false);
    }
  });

  it('holds a critical incident that names only a provider', () => {
    // The provider-conduct shape: no household resolved yet, but the
    // provider's other visits must stop.
    expect(
      isBookingHoldEligible({
        severity: 'critical',
        providerId: 'prv_1',
        seniorId: null,
        householdId: null,
      }),
    ).toBe(true);
  });
});
