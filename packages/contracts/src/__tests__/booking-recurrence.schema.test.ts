import { describe, expect, it } from 'vitest';

import {
  BookingRecurrencePatternSchema,
  BookingRecurrenceRecordSchema,
  CreateRecurringBookingRequestSchema,
  CreateRecurringBookingResponseSchema,
  RECURRENCE_MAX_OCCURRENCES,
  RRULE_MAX_LENGTH,
  SERIES_ID_MAX_LENGTH,
} from '../http';

/**
 * Booking-recurrence contract tests (TS-061; PRD §6.3).
 *
 * Validates the request / response schemas accept the Phase-1 happy
 * paths and reject the structural pitfalls (over-cap RRULE strings,
 * missing required fields, scheduledEnd <= scheduledStart, oversize
 * arrays).
 */

describe('BookingRecurrencePatternSchema', () => {
  it('accepts a valid RRULE string', () => {
    expect(BookingRecurrencePatternSchema.safeParse({ rrule: 'FREQ=WEEKLY;COUNT=4' }).success).toBe(
      true,
    );
  });

  it('rejects an empty RRULE string', () => {
    expect(BookingRecurrencePatternSchema.safeParse({ rrule: '' }).success).toBe(false);
  });

  it(`rejects RRULE strings over ${RRULE_MAX_LENGTH} chars`, () => {
    expect(
      BookingRecurrencePatternSchema.safeParse({ rrule: 'A'.repeat(RRULE_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level fields (strict mode)', () => {
    expect(
      BookingRecurrencePatternSchema.safeParse({
        rrule: 'FREQ=WEEKLY;COUNT=4',
        timezone: 'America/New_York',
      } as unknown).success,
    ).toBe(false);
  });
});

describe('CreateRecurringBookingRequestSchema', () => {
  const valid = {
    householdId: 'hh_abc',
    seniorId: 'sr_abc',
    providerId: 'prv_abc',
    serviceKind: 'companion_dining' as const,
    scheduledStart: '2026-05-14T18:00:00.000Z',
    scheduledEnd: '2026-05-14T20:00:00.000Z',
    currency: 'USD',
    basePriceMinor: 15_000,
    commissionRateBps: 3000,
    recurrence: { rrule: 'FREQ=WEEKLY;COUNT=4' },
  };

  it('accepts a minimal valid request', () => {
    expect(CreateRecurringBookingRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts optional bookingNotes', () => {
    expect(
      CreateRecurringBookingRequestSchema.safeParse({ ...valid, bookingNotes: 'Door code 1234' })
        .success,
    ).toBe(true);
  });

  it('rejects scheduledEnd <= scheduledStart', () => {
    expect(
      CreateRecurringBookingRequestSchema.safeParse({
        ...valid,
        scheduledEnd: valid.scheduledStart,
      }).success,
    ).toBe(false);
  });

  it('rejects basePriceMinor < 0', () => {
    expect(
      CreateRecurringBookingRequestSchema.safeParse({
        ...valid,
        basePriceMinor: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects commissionRateBps > 10000', () => {
    expect(
      CreateRecurringBookingRequestSchema.safeParse({
        ...valid,
        commissionRateBps: 10_001,
      }).success,
    ).toBe(false);
  });

  it('rejects requests without the recurrence block', () => {
    const { recurrence: _r, ...withoutRecurrence } = valid;
    expect(CreateRecurringBookingRequestSchema.safeParse(withoutRecurrence).success).toBe(false);
  });

  it('rejects unknown top-level fields (strict mode)', () => {
    expect(
      CreateRecurringBookingRequestSchema.safeParse({
        ...valid,
        notes: 'this is not a real field',
      } as unknown).success,
    ).toBe(false);
  });

  it('rejects currency != 3 chars', () => {
    expect(
      CreateRecurringBookingRequestSchema.safeParse({ ...valid, currency: 'US' }).success,
    ).toBe(false);
    expect(
      CreateRecurringBookingRequestSchema.safeParse({ ...valid, currency: 'USDX' }).success,
    ).toBe(false);
  });
});

describe('BookingRecurrenceRecordSchema', () => {
  const valid = {
    seriesId: 'srs_abc',
    rrule: 'FREQ=WEEKLY;COUNT=4',
    endDate: null,
    count: 4,
    occurrenceCount: 4,
    createdAt: '2026-05-13T12:00:00.000Z',
    updatedAt: '2026-05-13T12:00:00.000Z',
  };

  it('accepts COUNT-terminated records (count set, endDate null)', () => {
    expect(BookingRecurrenceRecordSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts UNTIL-terminated records (endDate set, count null)', () => {
    expect(
      BookingRecurrenceRecordSchema.safeParse({
        ...valid,
        count: null,
        endDate: '2026-09-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('rejects occurrenceCount > RECURRENCE_MAX_OCCURRENCES', () => {
    expect(
      BookingRecurrenceRecordSchema.safeParse({
        ...valid,
        occurrenceCount: RECURRENCE_MAX_OCCURRENCES + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects occurrenceCount < 1', () => {
    expect(BookingRecurrenceRecordSchema.safeParse({ ...valid, occurrenceCount: 0 }).success).toBe(
      false,
    );
  });

  it(`rejects seriesId > ${SERIES_ID_MAX_LENGTH} chars`, () => {
    expect(
      BookingRecurrenceRecordSchema.safeParse({
        ...valid,
        seriesId: 's'.repeat(SERIES_ID_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level fields (strict mode)', () => {
    expect(
      BookingRecurrenceRecordSchema.safeParse({ ...valid, extra: true } as unknown).success,
    ).toBe(false);
  });
});

describe('CreateRecurringBookingResponseSchema', () => {
  it('rejects responses with zero bookings', () => {
    expect(
      CreateRecurringBookingResponseSchema.safeParse({
        recurrence: {
          seriesId: 'srs_abc',
          rrule: 'FREQ=WEEKLY;COUNT=4',
          endDate: null,
          count: 4,
          occurrenceCount: 4,
          createdAt: '2026-05-13T12:00:00.000Z',
          updatedAt: '2026-05-13T12:00:00.000Z',
        },
        bookings: [],
      }).success,
    ).toBe(false);
  });
});
