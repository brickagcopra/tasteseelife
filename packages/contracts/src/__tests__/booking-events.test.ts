import { describe, expect, it } from 'vitest';

import {
  BOOKING_CANCELED,
  BOOKING_COMPLETED,
  BOOKING_CONFIRMED,
  BOOKING_CREATED,
  BOOKING_DECLINED,
  BOOKING_IN_PROGRESS,
  BookingCancellationReasonSchema,
  BookingCanceledSchema,
  BookingCompletedSchema,
  BookingConfirmedSchema,
  BookingCreatedSchema,
  BookingDeclineKindSchema,
  BookingDeclineReasonSchema,
  BookingDeclinedSchema,
  BookingInProgressSchema,
  BookingServiceKindSchema,
  eventRegistry,
  getEventSchema,
} from '../events';

const baseIdentifiers = {
  bookingId: 'bkg_abc',
  householdId: 'hh_abc',
  seniorId: 'sr_abc',
  providerId: 'prv_abc',
  serviceKind: 'companion_dining' as const,
};

const baseEnvelope = {
  eventId: 'evt_abc',
  occurredAt: '2026-05-13T12:00:00.000Z',
};

describe('booking event constants', () => {
  it('registers all six lifecycle events in the registry', () => {
    expect(eventRegistry[BOOKING_CREATED]).toBeDefined();
    expect(eventRegistry[BOOKING_CONFIRMED]).toBeDefined();
    expect(eventRegistry[BOOKING_IN_PROGRESS]).toBeDefined();
    expect(eventRegistry[BOOKING_COMPLETED]).toBeDefined();
    expect(eventRegistry[BOOKING_CANCELED]).toBeDefined();
    expect(eventRegistry[BOOKING_DECLINED]).toBeDefined();
  });

  it('uses past-tense dotted event names (CLAUDE.md §2.2)', () => {
    [
      BOOKING_CREATED,
      BOOKING_CONFIRMED,
      BOOKING_IN_PROGRESS,
      BOOKING_COMPLETED,
      BOOKING_CANCELED,
      BOOKING_DECLINED,
    ].forEach((name) => {
      expect(name).toMatch(/^booking\.[a-z][a-z0-9_]*$/);
    });
  });

  it('getEventSchema resolves all six names', () => {
    expect(getEventSchema(BOOKING_CREATED)).toBe(BookingCreatedSchema);
    expect(getEventSchema(BOOKING_CONFIRMED)).toBe(BookingConfirmedSchema);
    expect(getEventSchema(BOOKING_IN_PROGRESS)).toBe(BookingInProgressSchema);
    expect(getEventSchema(BOOKING_COMPLETED)).toBe(BookingCompletedSchema);
    expect(getEventSchema(BOOKING_CANCELED)).toBe(BookingCanceledSchema);
    expect(getEventSchema(BOOKING_DECLINED)).toBe(BookingDeclinedSchema);
  });
});

describe('BookingServiceKindSchema', () => {
  it('accepts every service kind (basic + Tier-3 concierge)', () => {
    const kinds = [
      // Basic-marketplace kinds (PRD §6.3).
      'companion_dining',
      'personal_chef_visit',
      'grocery_coordination',
      'transportation',
      'social_outing',
      'event_dining',
      'emergency_concierge',
      // Tier-3 concierge experiences (PRD §6.6, TS-220).
      'holiday_dinner',
      'birthday_experience',
      'tea_social',
      'museum_outing',
      'memory_meal',
      'custom_request',
    ];
    for (const kind of kinds) {
      expect(BookingServiceKindSchema.safeParse(kind).success).toBe(true);
    }
  });

  it('rejects unknown service kinds', () => {
    expect(BookingServiceKindSchema.safeParse('massage').success).toBe(false);
  });
});

describe('BookingCancellationReasonSchema', () => {
  it('accepts every reason in the enum', () => {
    const reasons = [
      'family_request',
      'provider_unavailable',
      'no_show',
      'welfare_concern',
      'admin_action',
      'other',
    ];
    for (const r of reasons) {
      expect(BookingCancellationReasonSchema.safeParse(r).success).toBe(true);
    }
  });

  it('rejects free-form reasons', () => {
    expect(BookingCancellationReasonSchema.safeParse('any-string').success).toBe(false);
  });
});

describe('BookingCreatedSchema', () => {
  const valid = {
    ...baseEnvelope,
    ...baseIdentifiers,
    scheduledStart: '2026-05-20T18:00:00.000Z',
    scheduledEnd: '2026-05-20T20:00:00.000Z',
    currency: 'USD',
    basePriceMinor: 15_000,
    commissionRateBps: 3000,
    commissionAmountMinor: 4_500,
    finalPriceMinor: 15_000,
  };

  it('accepts a valid payload', () => {
    expect(BookingCreatedSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(BookingCreatedSchema.safeParse({ ...valid, extra: 'no' }).success).toBe(false);
  });

  it('requires a 3-letter currency', () => {
    expect(BookingCreatedSchema.safeParse({ ...valid, currency: 'US' }).success).toBe(false);
    expect(BookingCreatedSchema.safeParse({ ...valid, currency: 'USDA' }).success).toBe(false);
  });

  it('rejects commissionRateBps > 10000', () => {
    expect(BookingCreatedSchema.safeParse({ ...valid, commissionRateBps: 10_001 }).success).toBe(
      false,
    );
  });

  it('rejects negative money fields', () => {
    expect(BookingCreatedSchema.safeParse({ ...valid, basePriceMinor: -1 }).success).toBe(false);
  });

  it('accepts an optional searchId (string, null, or omitted) — TS-217-prep-4c', () => {
    // Omitted (backward-compatible with pre-prep-4c events).
    expect(BookingCreatedSchema.safeParse(valid).success).toBe(true);
    // Present as the correlation token.
    expect(BookingCreatedSchema.safeParse({ ...valid, searchId: 'srch_abc123' }).success).toBe(
      true,
    );
    // Explicit null (booking that did not originate from a search).
    expect(BookingCreatedSchema.safeParse({ ...valid, searchId: null }).success).toBe(true);
  });

  it('rejects an empty or over-long searchId', () => {
    expect(BookingCreatedSchema.safeParse({ ...valid, searchId: '' }).success).toBe(false);
    expect(BookingCreatedSchema.safeParse({ ...valid, searchId: 'x'.repeat(129) }).success).toBe(
      false,
    );
  });
});

describe('BookingConfirmedSchema', () => {
  const valid = {
    ...baseEnvelope,
    ...baseIdentifiers,
    scheduledStart: '2026-05-20T18:00:00.000Z',
    scheduledEnd: '2026-05-20T20:00:00.000Z',
    confirmedAt: '2026-05-15T10:00:00.000Z',
  };

  it('accepts a valid payload', () => {
    expect(BookingConfirmedSchema.safeParse(valid).success).toBe(true);
  });

  it('requires confirmedAt', () => {
    const { confirmedAt, ...rest } = valid;
    void confirmedAt;
    expect(BookingConfirmedSchema.safeParse(rest).success).toBe(false);
  });
});

describe('BookingInProgressSchema', () => {
  const valid = {
    ...baseEnvelope,
    ...baseIdentifiers,
    startedAt: '2026-05-20T18:05:00.000Z',
  };

  it('accepts a valid payload', () => {
    expect(BookingInProgressSchema.safeParse(valid).success).toBe(true);
  });

  it('requires an ISO startedAt', () => {
    expect(BookingInProgressSchema.safeParse({ ...valid, startedAt: 'now' }).success).toBe(false);
  });
});

describe('BookingCompletedSchema', () => {
  const valid = {
    ...baseEnvelope,
    ...baseIdentifiers,
    completedAt: '2026-05-20T20:00:00.000Z',
    currency: 'USD',
    grossAmountMinor: 15_000,
    providerAmountMinor: 10_500,
    marketplaceAmountMinor: 4_500,
    commissionRateBps: 3000,
  };

  it('accepts a valid payload where gross = provider + marketplace', () => {
    expect(BookingCompletedSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects when gross != provider + marketplace (invariant)', () => {
    expect(
      BookingCompletedSchema.safeParse({ ...valid, providerAmountMinor: 10_000 }).success,
    ).toBe(false);
  });

  it('rejects negative amounts', () => {
    expect(BookingCompletedSchema.safeParse({ ...valid, grossAmountMinor: -1 }).success).toBe(
      false,
    );
  });
});

describe('BookingCanceledSchema', () => {
  const valid = {
    ...baseEnvelope,
    ...baseIdentifiers,
    canceledAt: '2026-05-19T15:00:00.000Z',
    previousStatus: 'confirmed' as const,
    cancellationReason: 'family_request' as const,
    canceledByUserId: 'usr_abc',
  };

  it('accepts a valid payload', () => {
    expect(BookingCanceledSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects `completed` as a previousStatus (cannot cancel from terminal)', () => {
    expect(
      BookingCanceledSchema.safeParse({ ...valid, previousStatus: 'completed' as never }).success,
    ).toBe(false);
  });

  it('rejects unknown cancellation reasons', () => {
    expect(
      BookingCanceledSchema.safeParse({ ...valid, cancellationReason: 'weather' as never }).success,
    ).toBe(false);
  });
});

describe('BookingDeclineKindSchema', () => {
  it('accepts every decline kind', () => {
    ['provider_declined', 'window_expired', 'admin_declined'].forEach((k) => {
      expect(BookingDeclineKindSchema.safeParse(k).success).toBe(true);
    });
  });

  it('rejects unknown decline kinds', () => {
    expect(BookingDeclineKindSchema.safeParse('family_request').success).toBe(false);
  });
});

describe('BookingDeclineReasonSchema', () => {
  it('accepts every Phase-1 reason', () => {
    [
      'schedule_conflict',
      'outside_service_area',
      'dietary_mismatch',
      'safety_concern',
      'other',
    ].forEach((r) => {
      expect(BookingDeclineReasonSchema.safeParse(r).success).toBe(true);
    });
  });

  it('rejects unknown reasons', () => {
    expect(BookingDeclineReasonSchema.safeParse('mood').success).toBe(false);
  });
});

describe('BookingDeclinedSchema', () => {
  const valid = {
    ...baseEnvelope,
    ...baseIdentifiers,
    scheduledStart: '2026-05-20T18:00:00.000Z',
    scheduledEnd: '2026-05-20T20:00:00.000Z',
    declinedAt: '2026-05-13T12:15:00.000Z',
    declineKind: 'provider_declined' as const,
    declineReason: 'schedule_conflict' as const,
    declinedByUserId: 'usr_provider',
  };

  it('accepts a valid provider_declined payload', () => {
    expect(BookingDeclinedSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a window_expired payload with null reason', () => {
    expect(
      BookingDeclinedSchema.safeParse({
        ...valid,
        declineKind: 'window_expired',
        declineReason: null,
        declinedByUserId: 'sys:booking-window-watcher',
      }).success,
    ).toBe(true);
  });

  it('accepts an admin_declined payload', () => {
    expect(
      BookingDeclinedSchema.safeParse({
        ...valid,
        declineKind: 'admin_declined',
        declinedByUserId: 'usr_admin',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown declineKind', () => {
    expect(
      BookingDeclinedSchema.safeParse({ ...valid, declineKind: 'system' as never }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(BookingDeclinedSchema.safeParse({ ...valid, extra: 'no' as never }).success).toBe(false);
  });
});
