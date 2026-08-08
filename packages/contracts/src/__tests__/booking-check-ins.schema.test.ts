import { describe, expect, it } from 'vitest';

import {
  BookingCheckInKindSchema,
  BookingCheckInResponseSchema,
  BookingCheckInsListResponseSchema,
  CHECK_IN_ACCURACY_METERS_MAX,
  CHECK_IN_LATITUDE_MAX,
  CHECK_IN_LATITUDE_MIN,
  CHECK_IN_LONGITUDE_MAX,
  CHECK_IN_LONGITUDE_MIN,
  RecordBookingCheckInRequestSchema,
  RecordBookingCheckInResponseSchema,
} from '../http';

/**
 * Booking check-ins contract tests (TS-063; PRD §7.4 provider visit
 * workflow).
 *
 * Validates the request / response schemas accept the Phase-1 happy
 * paths and reject the structural pitfalls (out-of-range coordinates,
 * unknown discriminator values, oversize accuracy, client-supplied
 * `occurredAt`).
 */

describe('BookingCheckInKindSchema', () => {
  it('accepts check_in and check_out', () => {
    expect(BookingCheckInKindSchema.safeParse('check_in').success).toBe(true);
    expect(BookingCheckInKindSchema.safeParse('check_out').success).toBe(true);
  });

  it('rejects unknown discriminator values', () => {
    expect(BookingCheckInKindSchema.safeParse('arrived').success).toBe(false);
    expect(BookingCheckInKindSchema.safeParse('CHECK_IN').success).toBe(false);
    expect(BookingCheckInKindSchema.safeParse('').success).toBe(false);
  });
});

describe('RecordBookingCheckInRequestSchema', () => {
  const minimal = {
    kind: 'check_in' as const,
    latitude: 40.7128,
    longitude: -74.006,
  };

  it('accepts a minimal request', () => {
    const result = RecordBookingCheckInRequestSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('accepts a request with locationAccuracyMeters', () => {
    expect(
      RecordBookingCheckInRequestSchema.safeParse({
        ...minimal,
        locationAccuracyMeters: 12.5,
      }).success,
    ).toBe(true);
  });

  it('accepts the boundary latitudes (±90)', () => {
    expect(RecordBookingCheckInRequestSchema.safeParse({ ...minimal, latitude: 90 }).success).toBe(
      true,
    );
    expect(RecordBookingCheckInRequestSchema.safeParse({ ...minimal, latitude: -90 }).success).toBe(
      true,
    );
  });

  it('accepts the boundary longitudes (±180)', () => {
    expect(
      RecordBookingCheckInRequestSchema.safeParse({ ...minimal, longitude: 180 }).success,
    ).toBe(true);
    expect(
      RecordBookingCheckInRequestSchema.safeParse({ ...minimal, longitude: -180 }).success,
    ).toBe(true);
  });

  it('rejects out-of-range latitudes', () => {
    expect(
      RecordBookingCheckInRequestSchema.safeParse({
        ...minimal,
        latitude: CHECK_IN_LATITUDE_MAX + 0.0001,
      }).success,
    ).toBe(false);
    expect(
      RecordBookingCheckInRequestSchema.safeParse({
        ...minimal,
        latitude: CHECK_IN_LATITUDE_MIN - 0.0001,
      }).success,
    ).toBe(false);
  });

  it('rejects out-of-range longitudes', () => {
    expect(
      RecordBookingCheckInRequestSchema.safeParse({
        ...minimal,
        longitude: CHECK_IN_LONGITUDE_MAX + 0.0001,
      }).success,
    ).toBe(false);
    expect(
      RecordBookingCheckInRequestSchema.safeParse({
        ...minimal,
        longitude: CHECK_IN_LONGITUDE_MIN - 0.0001,
      }).success,
    ).toBe(false);
  });

  it('rejects non-finite coordinates', () => {
    expect(
      RecordBookingCheckInRequestSchema.safeParse({ ...minimal, latitude: Number.NaN }).success,
    ).toBe(false);
    expect(
      RecordBookingCheckInRequestSchema.safeParse({
        ...minimal,
        longitude: Number.POSITIVE_INFINITY,
      }).success,
    ).toBe(false);
  });

  it('rejects negative accuracy', () => {
    expect(
      RecordBookingCheckInRequestSchema.safeParse({
        ...minimal,
        locationAccuracyMeters: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects accuracy beyond the safety cap', () => {
    expect(
      RecordBookingCheckInRequestSchema.safeParse({
        ...minimal,
        locationAccuracyMeters: CHECK_IN_ACCURACY_METERS_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(
      RecordBookingCheckInRequestSchema.safeParse({
        ...minimal,
        occurredAt: '2026-05-14T18:00:00.000Z',
      } as unknown).success,
    ).toBe(false);
    expect(
      RecordBookingCheckInRequestSchema.safeParse({
        ...minimal,
        recordedByUserId: 'usr_provider',
      } as unknown).success,
    ).toBe(false);
  });

  it('rejects missing required fields', () => {
    expect(RecordBookingCheckInRequestSchema.safeParse({ kind: 'check_in' }).success).toBe(false);
    expect(
      RecordBookingCheckInRequestSchema.safeParse({ latitude: 40, longitude: -74 }).success,
    ).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(
      RecordBookingCheckInRequestSchema.safeParse({ ...minimal, kind: 'arrived' }).success,
    ).toBe(false);
  });
});

describe('BookingCheckInResponseSchema', () => {
  const minimal = {
    id: 'chk_abc',
    bookingId: 'bkg_abc',
    kind: 'check_in' as const,
    latitude: 40.7128,
    longitude: -74.006,
    locationAccuracyMeters: null,
    occurredAt: '2026-05-14T18:00:00.000Z',
    recordedByUserId: 'usr_provider',
    createdAt: '2026-05-14T18:00:00.000Z',
    updatedAt: '2026-05-14T18:00:00.000Z',
  };

  it('accepts a complete response', () => {
    expect(BookingCheckInResponseSchema.safeParse(minimal).success).toBe(true);
  });

  it('accepts an accuracy number', () => {
    expect(
      BookingCheckInResponseSchema.safeParse({ ...minimal, locationAccuracyMeters: 8.5 }).success,
    ).toBe(true);
  });

  it('rejects an invalid timestamp', () => {
    expect(
      BookingCheckInResponseSchema.safeParse({ ...minimal, occurredAt: 'not-a-timestamp' }).success,
    ).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(BookingCheckInResponseSchema.safeParse({ ...minimal, kind: 'arrived' }).success).toBe(
      false,
    );
  });

  it('rejects unknown top-level fields (strict mode)', () => {
    expect(
      BookingCheckInResponseSchema.safeParse({
        ...minimal,
        deviceModel: 'Pixel 9',
      } as unknown).success,
    ).toBe(false);
  });
});

describe('RecordBookingCheckInResponseSchema', () => {
  const sampleCheckIn = {
    id: 'chk_abc',
    bookingId: 'bkg_abc',
    kind: 'check_in' as const,
    latitude: 40.7128,
    longitude: -74.006,
    locationAccuracyMeters: 10,
    occurredAt: '2026-05-14T18:00:00.000Z',
    recordedByUserId: 'usr_provider',
    createdAt: '2026-05-14T18:00:00.000Z',
    updatedAt: '2026-05-14T18:00:00.000Z',
  };

  const sampleBooking = {
    id: 'bkg_abc',
    householdId: 'hh_abc',
    seniorId: 'sr_abc',
    providerId: 'prv_abc',
    serviceKind: 'companion_dining' as const,
    status: 'in_progress' as const,
    scheduledStart: '2026-05-14T18:00:00.000Z',
    scheduledEnd: '2026-05-14T20:00:00.000Z',
    currency: 'USD',
    basePriceMinor: 15_000,
    commissionRateBps: 3000,
    commissionAmountMinor: 4_500,
    finalPriceMinor: 15_000,
    bookingNotes: null,
    completedAt: null,
    canceledAt: null,
    cancellationReason: null,
    cancellationReasonText: null,
    acceptWindowExpiresAt: '2026-05-13T12:30:00.000Z',
    declinedAt: null,
    declineKind: null,
    declineReason: null,
    declineReasonText: null,
    declinedByUserId: null,
    onHold: false,
    createdAt: '2026-05-13T12:00:00.000Z',
    updatedAt: '2026-05-14T18:00:00.000Z',
  };

  it('accepts a complete response carrying both subshapes', () => {
    expect(
      RecordBookingCheckInResponseSchema.safeParse({
        checkIn: sampleCheckIn,
        booking: sampleBooking,
      }).success,
    ).toBe(true);
  });

  it('rejects when checkIn is missing', () => {
    expect(
      RecordBookingCheckInResponseSchema.safeParse({ booking: sampleBooking } as unknown).success,
    ).toBe(false);
  });

  it('rejects when booking is missing', () => {
    expect(
      RecordBookingCheckInResponseSchema.safeParse({ checkIn: sampleCheckIn } as unknown).success,
    ).toBe(false);
  });
});

describe('BookingCheckInsListResponseSchema', () => {
  it('accepts an empty list', () => {
    expect(BookingCheckInsListResponseSchema.safeParse({ items: [] }).success).toBe(true);
  });

  it('accepts a populated list', () => {
    const row = {
      id: 'chk_abc',
      bookingId: 'bkg_abc',
      kind: 'check_in' as const,
      latitude: 40.7128,
      longitude: -74.006,
      locationAccuracyMeters: null,
      occurredAt: '2026-05-14T18:00:00.000Z',
      recordedByUserId: 'usr_provider',
      createdAt: '2026-05-14T18:00:00.000Z',
      updatedAt: '2026-05-14T18:00:00.000Z',
    };
    expect(BookingCheckInsListResponseSchema.safeParse({ items: [row, row] }).success).toBe(true);
  });

  it('rejects unknown top-level fields (strict mode)', () => {
    expect(
      BookingCheckInsListResponseSchema.safeParse({
        items: [],
        cursor: null,
      } as unknown).success,
    ).toBe(false);
  });
});
