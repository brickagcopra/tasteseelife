import { describe, expect, it } from 'vitest';

import {
  AcceptBookingRequestSchema,
  BOOKING_ACCEPT_WINDOW_MINUTES_DEFAULT,
  BOOKING_ACCEPT_WINDOW_MINUTES_MAX,
  BOOKING_ACCEPT_WINDOW_MINUTES_MIN,
  BOOKING_CANCELLATION_REASON_TEXT_MAX_LENGTH,
  BOOKING_DECLINE_REASON_TEXT_MAX_LENGTH,
  BOOKING_NOTES_MAX_LENGTH,
  BookingResponseSchema,
  BookingStatusSchema,
  CreateBookingRequestSchema,
  DeclineBookingRequestSchema,
  TransitionBookingStatusRequestSchema,
  TransitionableBookingStatusSchema,
} from '../http';

describe('BookingStatusSchema', () => {
  it('accepts every lifecycle state', () => {
    ['pending', 'confirmed', 'in_progress', 'completed', 'canceled', 'declined'].forEach((s) => {
      expect(BookingStatusSchema.safeParse(s).success).toBe(true);
    });
  });

  it('rejects unknown states', () => {
    expect(BookingStatusSchema.safeParse('archived').success).toBe(false);
  });
});

describe('TransitionableBookingStatusSchema', () => {
  it('rejects `pending` (cannot transition back to pending)', () => {
    expect(TransitionableBookingStatusSchema.safeParse('pending').success).toBe(false);
  });

  it('accepts confirmed/in_progress/completed/canceled', () => {
    ['confirmed', 'in_progress', 'completed', 'canceled'].forEach((s) => {
      expect(TransitionableBookingStatusSchema.safeParse(s).success).toBe(true);
    });
  });
});

describe('CreateBookingRequestSchema', () => {
  const valid = {
    householdId: 'hh_abc',
    seniorId: 'sr_abc',
    providerId: 'prv_abc',
    serviceKind: 'companion_dining' as const,
    scheduledStart: '2026-05-20T18:00:00.000Z',
    scheduledEnd: '2026-05-20T20:00:00.000Z',
    currency: 'USD',
    basePriceMinor: 15_000,
    commissionRateBps: 3000,
  };

  it('accepts a minimal valid request', () => {
    expect(CreateBookingRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts bookingNotes within the cap', () => {
    expect(
      CreateBookingRequestSchema.safeParse({ ...valid, bookingNotes: 'door code 1234' }).success,
    ).toBe(true);
  });

  it('rejects bookingNotes beyond the cap', () => {
    expect(
      CreateBookingRequestSchema.safeParse({
        ...valid,
        bookingNotes: 'x'.repeat(BOOKING_NOTES_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(CreateBookingRequestSchema.safeParse({ ...valid, sneaky: 'no' as never }).success).toBe(
      false,
    );
  });

  it('rejects scheduledEnd <= scheduledStart', () => {
    expect(
      CreateBookingRequestSchema.safeParse({
        ...valid,
        scheduledEnd: valid.scheduledStart,
      }).success,
    ).toBe(false);
    expect(
      CreateBookingRequestSchema.safeParse({
        ...valid,
        scheduledStart: '2026-05-20T20:00:00.000Z',
        scheduledEnd: '2026-05-20T18:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('rejects negative basePriceMinor', () => {
    expect(CreateBookingRequestSchema.safeParse({ ...valid, basePriceMinor: -1 }).success).toBe(
      false,
    );
  });

  it('accepts an optional searchId — TS-217-prep-4c', () => {
    expect(CreateBookingRequestSchema.safeParse({ ...valid, searchId: 'srch_xyz' }).success).toBe(
      true,
    );
  });

  it('rejects an empty or over-long searchId', () => {
    expect(CreateBookingRequestSchema.safeParse({ ...valid, searchId: '' }).success).toBe(false);
    expect(
      CreateBookingRequestSchema.safeParse({ ...valid, searchId: 'x'.repeat(129) }).success,
    ).toBe(false);
  });

  it('rejects commissionRateBps outside 0..10000', () => {
    expect(CreateBookingRequestSchema.safeParse({ ...valid, commissionRateBps: -1 }).success).toBe(
      false,
    );
    expect(
      CreateBookingRequestSchema.safeParse({ ...valid, commissionRateBps: 10_001 }).success,
    ).toBe(false);
  });

  it('rejects non-3-letter currency', () => {
    expect(CreateBookingRequestSchema.safeParse({ ...valid, currency: 'US' }).success).toBe(false);
    expect(CreateBookingRequestSchema.safeParse({ ...valid, currency: 'USDA' }).success).toBe(
      false,
    );
  });

  it('rejects a valid-length non-USD currency (TS-060-followup-1b allow-list)', () => {
    // Phase-1 is USD-only (PRD §11.4). A well-formed ISO-4217 code that
    // is not on the allow-list is a 400 at the wire so it never reaches
    // the service or the booking-commission recognizer (TS-083).
    expect(CreateBookingRequestSchema.safeParse({ ...valid, currency: 'EUR' }).success).toBe(false);
    expect(CreateBookingRequestSchema.safeParse({ ...valid, currency: 'GBP' }).success).toBe(false);
    // Case-sensitive: the enum pins the exact upper-case code.
    expect(CreateBookingRequestSchema.safeParse({ ...valid, currency: 'usd' }).success).toBe(false);
  });

  it('accepts the USD allow-list value', () => {
    expect(CreateBookingRequestSchema.safeParse({ ...valid, currency: 'USD' }).success).toBe(true);
  });
});

describe('TransitionBookingStatusRequestSchema', () => {
  it('accepts a confirm transition without cancellation fields', () => {
    expect(
      TransitionBookingStatusRequestSchema.safeParse({ targetStatus: 'confirmed' }).success,
    ).toBe(true);
  });

  it('requires cancellationReason when targetStatus = canceled', () => {
    expect(
      TransitionBookingStatusRequestSchema.safeParse({ targetStatus: 'canceled' }).success,
    ).toBe(false);
  });

  it('accepts a cancel with a categorical reason', () => {
    expect(
      TransitionBookingStatusRequestSchema.safeParse({
        targetStatus: 'canceled',
        cancellationReason: 'family_request',
      }).success,
    ).toBe(true);
  });

  it('rejects cancellationReason on a non-cancel transition', () => {
    expect(
      TransitionBookingStatusRequestSchema.safeParse({
        targetStatus: 'confirmed',
        cancellationReason: 'family_request',
      }).success,
    ).toBe(false);
  });

  it('rejects cancellationReasonText without a categorical reason', () => {
    expect(
      TransitionBookingStatusRequestSchema.safeParse({
        targetStatus: 'canceled',
        cancellationReasonText: 'just because',
      }).success,
    ).toBe(false);
  });

  it('accepts a cancel with categorical reason + free-form text', () => {
    expect(
      TransitionBookingStatusRequestSchema.safeParse({
        targetStatus: 'canceled',
        cancellationReason: 'other',
        cancellationReasonText: 'flight delayed',
      }).success,
    ).toBe(true);
  });

  it('rejects free-form text beyond the cap', () => {
    expect(
      TransitionBookingStatusRequestSchema.safeParse({
        targetStatus: 'canceled',
        cancellationReason: 'other',
        cancellationReasonText: 'x'.repeat(BOOKING_CANCELLATION_REASON_TEXT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(
      TransitionBookingStatusRequestSchema.safeParse({
        targetStatus: 'confirmed',
        extra: 'no' as never,
      }).success,
    ).toBe(false);
  });
});

describe('BookingResponseSchema', () => {
  const valid = {
    id: 'bkg_abc',
    householdId: 'hh_abc',
    seniorId: 'sr_abc',
    providerId: 'prv_abc',
    serviceKind: 'companion_dining' as const,
    status: 'pending' as const,
    scheduledStart: '2026-05-20T18:00:00.000Z',
    scheduledEnd: '2026-05-20T20:00:00.000Z',
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
    updatedAt: '2026-05-13T12:00:00.000Z',
  };

  it('accepts a valid response', () => {
    expect(BookingResponseSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a declined response with populated decline metadata', () => {
    const declined = {
      ...valid,
      status: 'declined' as const,
      declinedAt: '2026-05-13T12:20:00.000Z',
      declineKind: 'provider_declined' as const,
      declineReason: 'schedule_conflict' as const,
      declineReasonText: 'double-booked at 6pm',
      declinedByUserId: 'usr_provider',
    };
    expect(BookingResponseSchema.safeParse(declined).success).toBe(true);
  });

  it('accepts an auto-decline (window_expired) with null reason', () => {
    const auto = {
      ...valid,
      status: 'declined' as const,
      declinedAt: '2026-05-13T12:30:00.000Z',
      declineKind: 'window_expired' as const,
      declineReason: null,
      declineReasonText: null,
      declinedByUserId: 'sys:booking-window-watcher',
    };
    expect(BookingResponseSchema.safeParse(auto).success).toBe(true);
  });

  it('accepts a null acceptWindowExpiresAt (back-fill / admin-created)', () => {
    expect(BookingResponseSchema.safeParse({ ...valid, acceptWindowExpiresAt: null }).success).toBe(
      true,
    );
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(BookingResponseSchema.safeParse({ ...valid, extra: 'no' as never }).success).toBe(false);
  });

  describe('trust & safety hold (TS-304-followup-1)', () => {
    it('requires onHold — a booking cannot omit whether it is suspended', () => {
      // TS-304 shipped the hold as ENFORCED and INVISIBLE. Making the field
      // optional would have preserved exactly that: every existing mapper
      // would still compile and still say nothing.
      const { onHold: _omitted, ...withoutHold } = valid;
      expect(BookingResponseSchema.safeParse(withoutHold).success).toBe(false);
    });

    it('accepts a held booking', () => {
      expect(BookingResponseSchema.safeParse({ ...valid, onHold: true }).success).toBe(true);
    });

    it('REJECTS an incident id on the wire', () => {
      // `.strict()` makes this a gateway 502 rather than a leak: the family
      // portal receives this shape, and a hold means somebody — possibly the
      // reader — is under review for a high or critical concern. The ops view
      // is GET /api/v1/admin/booking-holds, gated `trust_safety:read`.
      for (const leak of [
        { heldByIncidentId: 'inc_abc' },
        { incidentId: 'inc_abc' },
        { heldAt: '2026-07-20T10:00:00.000Z' },
        { holdSeverity: 'critical' },
        { holdCategory: 'welfare' },
      ]) {
        expect(BookingResponseSchema.safeParse({ ...valid, onHold: true, ...leak }).success).toBe(
          false,
        );
      }
    });
  });
});

describe('AcceptBookingRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(AcceptBookingRequestSchema.safeParse({}).success).toBe(true);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(AcceptBookingRequestSchema.safeParse({ note: 'will be late' as never }).success).toBe(
      false,
    );
  });
});

describe('DeclineBookingRequestSchema', () => {
  it('accepts the minimal categorical-reason body', () => {
    expect(
      DeclineBookingRequestSchema.safeParse({ declineReason: 'schedule_conflict' }).success,
    ).toBe(true);
  });

  it('accepts a categorical reason + free-form text', () => {
    expect(
      DeclineBookingRequestSchema.safeParse({
        declineReason: 'other',
        declineReasonText: 'family event',
      }).success,
    ).toBe(true);
  });

  it('rejects missing declineReason', () => {
    expect(DeclineBookingRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown declineReason values', () => {
    expect(DeclineBookingRequestSchema.safeParse({ declineReason: 'mood' as never }).success).toBe(
      false,
    );
  });

  it('rejects declineReasonText beyond the cap', () => {
    expect(
      DeclineBookingRequestSchema.safeParse({
        declineReason: 'other',
        declineReasonText: 'x'.repeat(BOOKING_DECLINE_REASON_TEXT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(
      DeclineBookingRequestSchema.safeParse({
        declineReason: 'schedule_conflict',
        extra: 'no' as never,
      }).success,
    ).toBe(false);
  });
});

describe('Accept window bounds', () => {
  it('default is 30 minutes', () => {
    expect(BOOKING_ACCEPT_WINDOW_MINUTES_DEFAULT).toBe(30);
  });

  it('min is 1 minute', () => {
    expect(BOOKING_ACCEPT_WINDOW_MINUTES_MIN).toBe(1);
  });

  it('max is 24 hours', () => {
    expect(BOOKING_ACCEPT_WINDOW_MINUTES_MAX).toBe(1440);
  });
});
