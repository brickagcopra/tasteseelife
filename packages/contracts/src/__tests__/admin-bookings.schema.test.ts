import { describe, expect, it } from 'vitest';

import {
  ADMIN_BOOKINGS_CHECK_INS_MAX,
  ADMIN_BOOKINGS_DISPUTES_MAX,
  ADMIN_BOOKINGS_LIST_LIMIT_DEFAULT,
  ADMIN_BOOKINGS_LIST_LIMIT_MAX,
  AdminBookingCheckInSummarySchema,
  AdminBookingDetailResponseSchema,
  AdminBookingDetailSchema,
  AdminBookingDisputeSummarySchema,
  AdminBookingRecurrenceSummarySchema,
  AdminBookingSummarySchema,
  AdminBookingVisitNoteSummarySchema,
  AdminBookingsListQuerySchema,
  AdminBookingsListResponseSchema,
  type AdminBookingDetail,
  type AdminBookingSummary,
} from '../http/admin-bookings.schema';

const NOW_ISO = '2026-05-18T12:00:00.000Z';
const LATER_ISO = '2026-05-18T14:00:00.000Z';

const sampleSummary: AdminBookingSummary = {
  id: 'bkg_abc',
  householdId: 'hh_abc',
  seniorId: 'sen_abc',
  providerId: 'pro_abc',
  serviceKind: 'companion_dining',
  status: 'confirmed',
  scheduledStart: NOW_ISO,
  scheduledEnd: LATER_ISO,
  currency: 'USD',
  basePriceMinor: 15000,
  commissionRateBps: 2000,
  commissionAmountMinor: 3000,
  finalPriceMinor: 15000,
  completedAt: null,
  canceledAt: null,
  cancellationReason: null,
  isRecurring: false,
  onHold: false,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const sampleVisitNote = {
  id: 'note_abc',
  mood: 'bright' as const,
  appetite: 'hearty' as const,
  hydration: 'good' as const,
  socialEngagement: 'engaged' as const,
  freeform: 'Lovely afternoon — talked about Italy.',
  photoKeys: ['media_abc', 'media_def'],
  recordedByUserId: 'usr_pro_abc',
  recordedAt: NOW_ISO,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const sampleCheckIn = {
  id: 'chk_abc',
  kind: 'check_in' as const,
  latitude: 40.776676,
  longitude: -73.97199,
  locationAccuracyMeters: 12.5,
  occurredAt: NOW_ISO,
  recordedByUserId: 'usr_pro_abc',
  createdAt: NOW_ISO,
};

const sampleDispute = {
  id: 'disp_abc',
  openedByUserId: 'usr_fam_abc',
  openedByRole: 'family' as const,
  reason: 'service_quality' as const,
  reasonDetail: 'Meal arrived cold.',
  status: 'open' as const,
  resolutionNotes: null as string | null,
  resolvedByUserId: null as string | null,
  resolvedAt: null as string | null,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const sampleRecurrence = {
  seriesId: 'ser_abc',
  rrule: 'FREQ=WEEKLY;INTERVAL=1;COUNT=12',
  endDate: null,
  count: 12,
  occurrenceCount: 12,
  seriesIndex: 2,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const sampleDetail: AdminBookingDetail = {
  id: 'bkg_abc',
  householdId: 'hh_abc',
  seniorId: 'sen_abc',
  providerId: 'pro_abc',
  serviceKind: 'companion_dining',
  status: 'completed',
  scheduledStart: NOW_ISO,
  scheduledEnd: LATER_ISO,
  currency: 'USD',
  basePriceMinor: 15000,
  commissionRateBps: 2000,
  commissionAmountMinor: 3000,
  finalPriceMinor: 15000,
  bookingNotes: 'Door code 1234. Allergic to shellfish.',
  completedAt: LATER_ISO,
  canceledAt: null,
  cancellationReason: null,
  cancellationReasonText: null,
  createdAt: NOW_ISO,
  updatedAt: LATER_ISO,
  visitNote: sampleVisitNote,
  checkIns: [sampleCheckIn],
  disputes: [],
  recurrence: null,
};

describe('AdminBookingsListQuerySchema', () => {
  it('returns a fully-defaulted parse when no filters supplied', () => {
    const parsed = AdminBookingsListQuerySchema.parse({});
    expect(parsed.limit).toBe(ADMIN_BOOKINGS_LIST_LIMIT_DEFAULT);
    expect(parsed.householdId).toBeUndefined();
    expect(parsed.providerId).toBeUndefined();
    expect(parsed.seniorId).toBeUndefined();
    expect(parsed.serviceKind).toBeUndefined();
    expect(parsed.status).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
  });

  it('coerces a numeric-string limit (URL query params arrive as strings)', () => {
    const parsed = AdminBookingsListQuerySchema.parse({ limit: '40' });
    expect(parsed.limit).toBe(40);
  });

  it('rejects a limit above the bound', () => {
    expect(
      AdminBookingsListQuerySchema.safeParse({
        limit: ADMIN_BOOKINGS_LIST_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-positive limit', () => {
    expect(AdminBookingsListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(AdminBookingsListQuerySchema.safeParse({ limit: -1 }).success).toBe(false);
  });

  it('accepts every BookingServiceKind enum value', () => {
    for (const kind of [
      'companion_dining',
      'personal_chef_visit',
      'grocery_coordination',
      'transportation',
      'social_outing',
      'event_dining',
      'emergency_concierge',
    ] as const) {
      const parsed = AdminBookingsListQuerySchema.parse({ serviceKind: kind });
      expect(parsed.serviceKind).toBe(kind);
    }
  });

  it('rejects an unknown serviceKind value', () => {
    expect(AdminBookingsListQuerySchema.safeParse({ serviceKind: 'mystery' }).success).toBe(false);
  });

  it('accepts every BookingStatus enum value as the status filter', () => {
    for (const status of [
      'pending',
      'confirmed',
      'in_progress',
      'completed',
      'canceled',
    ] as const) {
      const parsed = AdminBookingsListQuerySchema.parse({ status });
      expect(parsed.status).toBe(status);
    }
  });

  it('rejects an unknown status value', () => {
    expect(AdminBookingsListQuerySchema.safeParse({ status: 'mystery' }).success).toBe(false);
  });

  it('rejects empty householdId / providerId / seniorId', () => {
    expect(AdminBookingsListQuerySchema.safeParse({ householdId: '' }).success).toBe(false);
    expect(AdminBookingsListQuerySchema.safeParse({ providerId: '' }).success).toBe(false);
    expect(AdminBookingsListQuerySchema.safeParse({ seniorId: '' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(AdminBookingsListQuerySchema.safeParse({ extra: 'nope' }).success).toBe(false);
  });
});

describe('AdminBookingSummarySchema', () => {
  it('round-trips the sample summary', () => {
    const parsed = AdminBookingSummarySchema.parse(sampleSummary);
    expect(parsed).toEqual(sampleSummary);
  });

  it('rejects a non-integer basePriceMinor', () => {
    expect(
      AdminBookingSummarySchema.safeParse({ ...sampleSummary, basePriceMinor: 100.5 }).success,
    ).toBe(false);
  });

  it('rejects a negative basePriceMinor', () => {
    expect(
      AdminBookingSummarySchema.safeParse({ ...sampleSummary, basePriceMinor: -1 }).success,
    ).toBe(false);
  });

  it('rejects commissionRateBps above 10000', () => {
    expect(
      AdminBookingSummarySchema.safeParse({ ...sampleSummary, commissionRateBps: 10001 }).success,
    ).toBe(false);
  });

  it('accepts a canceled cancellationReason + canceledAt', () => {
    const parsed = AdminBookingSummarySchema.parse({
      ...sampleSummary,
      status: 'canceled',
      cancellationReason: 'family_request',
      canceledAt: NOW_ISO,
    });
    expect(parsed.status).toBe('canceled');
    expect(parsed.cancellationReason).toBe('family_request');
    expect(parsed.canceledAt).toBe(NOW_ISO);
  });

  it('accepts isRecurring=true', () => {
    const parsed = AdminBookingSummarySchema.parse({
      ...sampleSummary,
      isRecurring: true,
    });
    expect(parsed.isRecurring).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    expect(AdminBookingSummarySchema.safeParse({ ...sampleSummary, extra: 'nope' }).success).toBe(
      false,
    );
  });
});

describe('AdminBookingsListResponseSchema', () => {
  it('accepts an empty list with no cursor', () => {
    const parsed = AdminBookingsListResponseSchema.parse({
      bookings: [],
      nextCursor: null,
    });
    expect(parsed.bookings).toEqual([]);
    expect(parsed.nextCursor).toBeNull();
  });

  it('accepts a populated list with a non-null cursor', () => {
    const parsed = AdminBookingsListResponseSchema.parse({
      bookings: [sampleSummary],
      nextCursor: 'abc123',
    });
    expect(parsed.bookings).toHaveLength(1);
    expect(parsed.nextCursor).toBe('abc123');
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminBookingsListResponseSchema.safeParse({
        bookings: [],
        nextCursor: null,
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('AdminBookingVisitNoteSummarySchema', () => {
  it('round-trips the sample visit-note shape', () => {
    const parsed = AdminBookingVisitNoteSummarySchema.parse(sampleVisitNote);
    expect(parsed.mood).toBe('bright');
    expect(parsed.photoKeys).toHaveLength(2);
  });

  it('accepts a fully-null observation row (partial save)', () => {
    const parsed = AdminBookingVisitNoteSummarySchema.parse({
      ...sampleVisitNote,
      mood: null,
      appetite: null,
      hydration: null,
      socialEngagement: null,
      freeform: null,
      photoKeys: [],
    });
    expect(parsed.mood).toBeNull();
    expect(parsed.photoKeys).toEqual([]);
  });

  it('rejects an unknown mood value', () => {
    expect(
      AdminBookingVisitNoteSummarySchema.safeParse({
        ...sampleVisitNote,
        mood: 'mystery',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminBookingVisitNoteSummarySchema.safeParse({
        ...sampleVisitNote,
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('AdminBookingCheckInSummarySchema', () => {
  it('round-trips the sample check-in shape', () => {
    const parsed = AdminBookingCheckInSummarySchema.parse(sampleCheckIn);
    expect(parsed.kind).toBe('check_in');
    expect(parsed.latitude).toBeCloseTo(40.776676);
  });

  it('rejects a latitude outside [-90, 90]', () => {
    expect(
      AdminBookingCheckInSummarySchema.safeParse({
        ...sampleCheckIn,
        latitude: 91,
      }).success,
    ).toBe(false);
  });

  it('rejects a longitude outside [-180, 180]', () => {
    expect(
      AdminBookingCheckInSummarySchema.safeParse({
        ...sampleCheckIn,
        longitude: 181,
      }).success,
    ).toBe(false);
  });

  it('accepts a null locationAccuracyMeters', () => {
    const parsed = AdminBookingCheckInSummarySchema.parse({
      ...sampleCheckIn,
      locationAccuracyMeters: null,
    });
    expect(parsed.locationAccuracyMeters).toBeNull();
  });

  it('accepts a check_out kind', () => {
    const parsed = AdminBookingCheckInSummarySchema.parse({
      ...sampleCheckIn,
      kind: 'check_out',
    });
    expect(parsed.kind).toBe('check_out');
  });
});

describe('AdminBookingDisputeSummarySchema', () => {
  it('round-trips an open dispute shape', () => {
    const parsed = AdminBookingDisputeSummarySchema.parse(sampleDispute);
    expect(parsed.status).toBe('open');
    expect(parsed.resolvedAt).toBeNull();
  });

  it('accepts a resolved dispute with notes', () => {
    const parsed = AdminBookingDisputeSummarySchema.parse({
      ...sampleDispute,
      status: 'resolved',
      resolutionNotes: 'Issued partial refund per ops policy.',
      resolvedByUserId: 'usr_admin_abc',
      resolvedAt: LATER_ISO,
    });
    expect(parsed.status).toBe('resolved');
    expect(parsed.resolvedByUserId).toBe('usr_admin_abc');
  });

  it('accepts every dispute reason enum value', () => {
    for (const reason of [
      'no_show',
      'late_arrival',
      'early_departure',
      'service_quality',
      'billing_dispute',
      'property_damage',
      'safety_concern',
      'welfare_concern',
      'other',
    ] as const) {
      const parsed = AdminBookingDisputeSummarySchema.parse({
        ...sampleDispute,
        reason,
      });
      expect(parsed.reason).toBe(reason);
    }
  });

  it('rejects an unknown dispute status', () => {
    expect(
      AdminBookingDisputeSummarySchema.safeParse({
        ...sampleDispute,
        status: 'mystery',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminBookingDisputeSummarySchema.safeParse({
        ...sampleDispute,
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('AdminBookingRecurrenceSummarySchema', () => {
  it('round-trips a COUNT-terminated series', () => {
    const parsed = AdminBookingRecurrenceSummarySchema.parse(sampleRecurrence);
    expect(parsed.count).toBe(12);
    expect(parsed.endDate).toBeNull();
  });

  it('accepts an UNTIL-terminated series', () => {
    const parsed = AdminBookingRecurrenceSummarySchema.parse({
      ...sampleRecurrence,
      count: null,
      endDate: '2026-12-31T23:59:59.000Z',
    });
    expect(parsed.count).toBeNull();
    expect(parsed.endDate).toBe('2026-12-31T23:59:59.000Z');
  });

  it('rejects a seriesIndex below 0', () => {
    expect(
      AdminBookingRecurrenceSummarySchema.safeParse({
        ...sampleRecurrence,
        seriesIndex: -1,
      }).success,
    ).toBe(false);
  });
});

describe('AdminBookingDetailSchema', () => {
  it('round-trips the sample detail shape', () => {
    const parsed = AdminBookingDetailSchema.parse(sampleDetail);
    expect(parsed.visitNote).not.toBeNull();
    expect(parsed.checkIns).toHaveLength(1);
    expect(parsed.disputes).toEqual([]);
    expect(parsed.recurrence).toBeNull();
  });

  it('accepts a null visitNote (booking without notes yet)', () => {
    const parsed = AdminBookingDetailSchema.parse({
      ...sampleDetail,
      visitNote: null,
    });
    expect(parsed.visitNote).toBeNull();
  });

  it('accepts a fully-populated recurring booking detail', () => {
    const parsed = AdminBookingDetailSchema.parse({
      ...sampleDetail,
      recurrence: sampleRecurrence,
    });
    expect(parsed.recurrence?.seriesId).toBe('ser_abc');
  });

  it('rejects too many check-in rows', () => {
    const tooMany = Array.from({ length: ADMIN_BOOKINGS_CHECK_INS_MAX + 1 }, () => ({
      ...sampleCheckIn,
    }));
    expect(
      AdminBookingDetailSchema.safeParse({
        ...sampleDetail,
        checkIns: tooMany,
      }).success,
    ).toBe(false);
  });

  it('rejects too many disputes', () => {
    const tooMany = Array.from({ length: ADMIN_BOOKINGS_DISPUTES_MAX + 1 }, () => ({
      ...sampleDispute,
    }));
    expect(
      AdminBookingDetailSchema.safeParse({
        ...sampleDetail,
        disputes: tooMany,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminBookingDetailSchema.safeParse({
        ...sampleDetail,
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('AdminBookingDetailResponseSchema', () => {
  it('round-trips the wrapped envelope', () => {
    const parsed = AdminBookingDetailResponseSchema.parse({
      booking: sampleDetail,
    });
    expect(parsed.booking.id).toBe('bkg_abc');
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminBookingDetailResponseSchema.safeParse({
        booking: sampleDetail,
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});
