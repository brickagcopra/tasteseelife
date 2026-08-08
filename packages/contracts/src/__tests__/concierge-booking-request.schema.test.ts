import { describe, expect, it } from 'vitest';

import {
  CreateConciergeBookingRequestSchema,
  type CreateConciergeBookingRequest,
} from '../http/concierge-booking-request.schema';

describe('CreateConciergeBookingRequestSchema', () => {
  const valid: CreateConciergeBookingRequest = {
    householdId: 'hh_abc',
    seniorId: 'snr_abc',
    providerId: 'prv_abc',
    serviceKind: 'companion_dining',
    scheduledStart: '2026-06-10T17:00:00.000Z',
    scheduledEnd: '2026-06-10T19:00:00.000Z',
    bookingNotes: 'mom prefers a quiet meal',
  };

  it('accepts a valid request', () => {
    expect(CreateConciergeBookingRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a request without bookingNotes', () => {
    const { bookingNotes: _, ...rest } = valid;
    expect(CreateConciergeBookingRequestSchema.safeParse(rest).success).toBe(true);
  });

  it('rejects an unknown field (strict)', () => {
    const result = CreateConciergeBookingRequestSchema.safeParse({
      ...valid,
      basePriceMinor: 12_000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { providerId: _, ...rest } = valid;
    expect(CreateConciergeBookingRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an unknown serviceKind', () => {
    expect(
      CreateConciergeBookingRequestSchema.safeParse({
        ...valid,
        serviceKind: 'midnight_serenade',
      }).success,
    ).toBe(false);
  });

  it('rejects scheduledEnd <= scheduledStart', () => {
    expect(
      CreateConciergeBookingRequestSchema.safeParse({
        ...valid,
        scheduledStart: '2026-06-10T19:00:00.000Z',
        scheduledEnd: '2026-06-10T19:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('rejects bookingNotes exceeding the 2000-char cap', () => {
    expect(
      CreateConciergeBookingRequestSchema.safeParse({
        ...valid,
        bookingNotes: 'a'.repeat(2_001),
      }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO scheduledStart', () => {
    expect(
      CreateConciergeBookingRequestSchema.safeParse({
        ...valid,
        scheduledStart: '2026-06-10 17:00',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty householdId', () => {
    expect(
      CreateConciergeBookingRequestSchema.safeParse({
        ...valid,
        householdId: '',
      }).success,
    ).toBe(false);
  });

  it('accepts an optional searchId — TS-217-prep-4c', () => {
    expect(
      CreateConciergeBookingRequestSchema.safeParse({ ...valid, searchId: 'srch_abc' }).success,
    ).toBe(true);
  });

  it('rejects an empty or over-long searchId', () => {
    expect(CreateConciergeBookingRequestSchema.safeParse({ ...valid, searchId: '' }).success).toBe(
      false,
    );
    expect(
      CreateConciergeBookingRequestSchema.safeParse({
        ...valid,
        searchId: 'x'.repeat(129),
      }).success,
    ).toBe(false);
  });
});
