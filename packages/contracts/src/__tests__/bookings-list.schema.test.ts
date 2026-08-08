import { describe, expect, it } from 'vitest';

import {
  BOOKINGS_LIST_LIMIT_DEFAULT,
  BOOKINGS_LIST_LIMIT_MAX,
  BookingsListResponseSchema,
  ListBookingsQuerySchema,
  type BookingsListResponse,
} from '../http/bookings-list.schema';

describe('ListBookingsQuerySchema', () => {
  it('requires householdId', () => {
    expect(ListBookingsQuerySchema.safeParse({}).success).toBe(false);
  });

  it('defaults limit to the documented default when omitted', () => {
    const parsed = ListBookingsQuerySchema.parse({ householdId: 'hh_abc' });
    expect(parsed.limit).toBe(BOOKINGS_LIST_LIMIT_DEFAULT);
  });

  it('coerces a numeric string limit (URL query params arrive as strings)', () => {
    const parsed = ListBookingsQuerySchema.parse({
      householdId: 'hh_abc',
      limit: '50',
    });
    expect(parsed.limit).toBe(50);
  });

  it('rejects a limit above the bound', () => {
    expect(
      ListBookingsQuerySchema.safeParse({
        householdId: 'hh_abc',
        limit: BOOKINGS_LIST_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('accepts an opaque cursor', () => {
    const parsed = ListBookingsQuerySchema.parse({
      householdId: 'hh_abc',
      cursor: 'opaque_token_xyz',
    });
    expect(parsed.cursor).toBe('opaque_token_xyz');
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      ListBookingsQuerySchema.safeParse({
        householdId: 'hh_abc',
        smuggled: '1',
      }).success,
    ).toBe(false);
  });
});

describe('BookingsListResponseSchema', () => {
  const sampleBooking = {
    id: 'bkg_1',
    householdId: 'hh_abc',
    seniorId: 'snr_abc',
    providerId: 'prv_abc',
    serviceKind: 'companion_dining' as const,
    status: 'pending' as const,
    scheduledStart: '2026-06-10T17:00:00.000Z',
    scheduledEnd: '2026-06-10T19:00:00.000Z',
    currency: 'USD',
    basePriceMinor: 15_000,
    commissionRateBps: 2_000,
    commissionAmountMinor: 3_000,
    finalPriceMinor: 15_000,
    bookingNotes: null,
    completedAt: null,
    canceledAt: null,
    cancellationReason: null,
    cancellationReasonText: null,
    acceptWindowExpiresAt: '2026-06-01T09:30:00.000Z',
    declinedAt: null,
    declineKind: null,
    declineReason: null,
    declineReasonText: null,
    declinedByUserId: null,
    onHold: false,
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
  };

  it('accepts an empty list with null cursor', () => {
    const empty: BookingsListResponse = { bookings: [], nextCursor: null };
    expect(BookingsListResponseSchema.safeParse(empty).success).toBe(true);
  });

  it('accepts a populated list with a non-null cursor', () => {
    const populated: BookingsListResponse = {
      bookings: [sampleBooking],
      nextCursor: 'next_page_token',
    };
    expect(BookingsListResponseSchema.safeParse(populated).success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      BookingsListResponseSchema.safeParse({
        bookings: [],
        nextCursor: null,
        smuggled: true,
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid booking inside the array', () => {
    expect(
      BookingsListResponseSchema.safeParse({
        bookings: [{ ...sampleBooking, status: 'mystery' }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});
