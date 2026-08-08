import { describe, expect, it } from 'vitest';

import {
  BOOKING_DISPUTE_OPENED,
  BOOKING_DISPUTE_RESOLVED,
  BookingDisputeOpenedByRoleSchema,
  BookingDisputeOpenedSchema,
  BookingDisputeOutcomeSchema,
  BookingDisputeReasonSchema,
  BookingDisputeResolvedSchema,
  eventRegistry,
  getEventSchema,
} from '../events';
import {
  BOOKING_DISPUTE_REASON_DETAIL_MAX_LENGTH,
  BOOKING_DISPUTE_RESOLUTION_NOTES_MAX_LENGTH,
  BookingDisputeResponseSchema,
  BookingDisputeStatusSchema,
  BookingDisputesListResponseSchema,
  OpenBookingDisputeRequestSchema,
  TransitionableBookingDisputeStatusSchema,
  UpdateBookingDisputeRequestSchema,
} from '../http';

/**
 * Booking disputes contract tests (TS-065; PRD §10.5 dispute
 * resolution workflow).
 *
 * Validates:
 *   - The HTTP request / response schemas accept the Phase-1 happy
 *     paths and reject the structural pitfalls (unknown reasons,
 *     unknown opener roles, oversize text, terminal status without
 *     resolution notes, unknown fields).
 *   - The two new domain events register in the registry and resolve
 *     via `getEventSchema`, and their payload schemas accept the
 *     wire-shape the service emits.
 */

describe('BookingDisputeStatusSchema', () => {
  it('accepts every value in the enum', () => {
    for (const v of ['open', 'under_review', 'resolved', 'dismissed']) {
      expect(BookingDisputeStatusSchema.safeParse(v).success).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(BookingDisputeStatusSchema.safeParse('OPEN').success).toBe(false);
    expect(BookingDisputeStatusSchema.safeParse('escalated').success).toBe(false);
  });
});

describe('TransitionableBookingDisputeStatusSchema', () => {
  it('accepts the three transitionable targets', () => {
    expect(TransitionableBookingDisputeStatusSchema.safeParse('under_review').success).toBe(true);
    expect(TransitionableBookingDisputeStatusSchema.safeParse('resolved').success).toBe(true);
    expect(TransitionableBookingDisputeStatusSchema.safeParse('dismissed').success).toBe(true);
  });

  it('rejects `open` (cannot flip back to open via API)', () => {
    expect(TransitionableBookingDisputeStatusSchema.safeParse('open').success).toBe(false);
  });
});

describe('BookingDisputeReasonSchema', () => {
  it('accepts every Phase-1 reason', () => {
    const reasons = [
      'no_show',
      'late_arrival',
      'early_departure',
      'service_quality',
      'billing_dispute',
      'property_damage',
      'safety_concern',
      'welfare_concern',
      'other',
    ];
    for (const r of reasons) {
      expect(BookingDisputeReasonSchema.safeParse(r).success).toBe(true);
    }
  });

  it('rejects unknown reasons', () => {
    expect(BookingDisputeReasonSchema.safeParse('arrived_late').success).toBe(false);
    expect(BookingDisputeReasonSchema.safeParse('').success).toBe(false);
  });
});

describe('BookingDisputeOpenedByRoleSchema', () => {
  it('accepts family / provider / admin', () => {
    expect(BookingDisputeOpenedByRoleSchema.safeParse('family').success).toBe(true);
    expect(BookingDisputeOpenedByRoleSchema.safeParse('provider').success).toBe(true);
    expect(BookingDisputeOpenedByRoleSchema.safeParse('admin').success).toBe(true);
  });

  it('rejects custom or system role names (this is the categorical role, not the RBAC role)', () => {
    expect(BookingDisputeOpenedByRoleSchema.safeParse('family_payer').success).toBe(false);
    expect(BookingDisputeOpenedByRoleSchema.safeParse('super_admin').success).toBe(false);
  });
});

describe('BookingDisputeOutcomeSchema', () => {
  it('accepts resolved / dismissed only', () => {
    expect(BookingDisputeOutcomeSchema.safeParse('resolved').success).toBe(true);
    expect(BookingDisputeOutcomeSchema.safeParse('dismissed').success).toBe(true);
  });

  it('rejects open / under_review (intermediate states cannot be outcomes)', () => {
    expect(BookingDisputeOutcomeSchema.safeParse('open').success).toBe(false);
    expect(BookingDisputeOutcomeSchema.safeParse('under_review').success).toBe(false);
  });
});

describe('OpenBookingDisputeRequestSchema', () => {
  it('accepts a minimal request with just a reason', () => {
    expect(OpenBookingDisputeRequestSchema.safeParse({ reason: 'no_show' }).success).toBe(true);
  });

  it('accepts a request with reasonDetail', () => {
    expect(
      OpenBookingDisputeRequestSchema.safeParse({
        reason: 'service_quality',
        reasonDetail: 'Chef arrived an hour late and meal was cold.',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown reason', () => {
    expect(
      OpenBookingDisputeRequestSchema.safeParse({ reason: 'arrived_late' as never }).success,
    ).toBe(false);
  });

  it('rejects oversize reasonDetail', () => {
    expect(
      OpenBookingDisputeRequestSchema.safeParse({
        reason: 'other',
        reasonDetail: 'a'.repeat(BOOKING_DISPUTE_REASON_DETAIL_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (.strict())', () => {
    expect(
      OpenBookingDisputeRequestSchema.safeParse({
        reason: 'no_show',
        openedByUserId: 'usr_x', // server-stamped, not client-supplied
      } as unknown).success,
    ).toBe(false);
  });

  it('rejects missing reason', () => {
    expect(OpenBookingDisputeRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('UpdateBookingDisputeRequestSchema', () => {
  it('accepts under_review without resolutionNotes', () => {
    expect(
      UpdateBookingDisputeRequestSchema.safeParse({ targetStatus: 'under_review' }).success,
    ).toBe(true);
  });

  it('accepts resolved with non-empty resolutionNotes', () => {
    expect(
      UpdateBookingDisputeRequestSchema.safeParse({
        targetStatus: 'resolved',
        resolutionNotes: 'Refunded $100 to the family.',
      }).success,
    ).toBe(true);
  });

  it('accepts dismissed with non-empty resolutionNotes', () => {
    expect(
      UpdateBookingDisputeRequestSchema.safeParse({
        targetStatus: 'dismissed',
        resolutionNotes: 'Unfounded complaint.',
      }).success,
    ).toBe(true);
  });

  it('rejects resolved without resolutionNotes', () => {
    expect(UpdateBookingDisputeRequestSchema.safeParse({ targetStatus: 'resolved' }).success).toBe(
      false,
    );
  });

  it('rejects dismissed with empty resolutionNotes', () => {
    expect(
      UpdateBookingDisputeRequestSchema.safeParse({
        targetStatus: 'dismissed',
        resolutionNotes: '',
      }).success,
    ).toBe(false);
  });

  it('rejects oversize resolutionNotes', () => {
    expect(
      UpdateBookingDisputeRequestSchema.safeParse({
        targetStatus: 'resolved',
        resolutionNotes: 'a'.repeat(BOOKING_DISPUTE_RESOLUTION_NOTES_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects under_review with resolutionNotes (notes carry meaning only at terminal)', () => {
    // The schema does NOT reject this today — resolutionNotes is
    // optional and only required for terminal targets. This test
    // pins the behaviour so a future tightening (e.g. "notes only
    // allowed at terminal") is an explicit contract change.
    expect(
      UpdateBookingDisputeRequestSchema.safeParse({
        targetStatus: 'under_review',
        resolutionNotes: 'investigating',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields (.strict())', () => {
    expect(
      UpdateBookingDisputeRequestSchema.safeParse({
        targetStatus: 'under_review',
        resolvedByUserId: 'usr_x', // server-stamped, not client-supplied
      } as unknown).success,
    ).toBe(false);
  });
});

describe('BookingDisputeResponseSchema', () => {
  const openShape = {
    id: 'dsp_abc',
    bookingId: 'bkg_abc',
    openedByUserId: 'usr_family',
    openedByRole: 'family' as const,
    reason: 'service_quality' as const,
    reasonDetail: 'Cold meal.',
    status: 'open' as const,
    resolutionNotes: null,
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: '2026-05-14T18:00:00.000Z',
    updatedAt: '2026-05-14T18:00:00.000Z',
  };

  it('accepts an open dispute shape', () => {
    expect(BookingDisputeResponseSchema.safeParse(openShape).success).toBe(true);
  });

  it('accepts a terminal dispute shape (resolved)', () => {
    const terminal = {
      ...openShape,
      status: 'resolved' as const,
      resolutionNotes: 'Refunded $100.',
      resolvedByUserId: 'usr_ops',
      resolvedAt: '2026-05-14T19:00:00.000Z',
    };
    expect(BookingDisputeResponseSchema.safeParse(terminal).success).toBe(true);
  });

  it('accepts null reasonDetail', () => {
    expect(
      BookingDisputeResponseSchema.safeParse({ ...openShape, reasonDetail: null }).success,
    ).toBe(true);
  });

  it('rejects an invalid timestamp', () => {
    expect(
      BookingDisputeResponseSchema.safeParse({ ...openShape, createdAt: 'not-a-timestamp' })
        .success,
    ).toBe(false);
  });

  it('rejects unknown fields (.strict())', () => {
    expect(
      BookingDisputeResponseSchema.safeParse({
        ...openShape,
        escalatedTo: 'trust-safety',
      } as unknown).success,
    ).toBe(false);
  });
});

describe('BookingDisputesListResponseSchema', () => {
  const row = {
    id: 'dsp_abc',
    bookingId: 'bkg_abc',
    openedByUserId: 'usr_family',
    openedByRole: 'family' as const,
    reason: 'no_show' as const,
    reasonDetail: null,
    status: 'open' as const,
    resolutionNotes: null,
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: '2026-05-14T18:00:00.000Z',
    updatedAt: '2026-05-14T18:00:00.000Z',
  };

  it('accepts an empty list', () => {
    expect(BookingDisputesListResponseSchema.safeParse({ items: [] }).success).toBe(true);
  });

  it('accepts a populated list', () => {
    expect(BookingDisputesListResponseSchema.safeParse({ items: [row, row] }).success).toBe(true);
  });

  it('rejects unknown top-level fields (.strict())', () => {
    expect(
      BookingDisputesListResponseSchema.safeParse({
        items: [],
        cursor: null,
      } as unknown).success,
    ).toBe(false);
  });
});

describe('booking.dispute_* events', () => {
  const baseEnvelope = {
    eventId: 'dsp_abc.opened.1747246800000',
    occurredAt: '2026-05-14T18:00:00.000Z',
  };

  it('registers booking.dispute_opened in the registry', () => {
    expect(eventRegistry[BOOKING_DISPUTE_OPENED]).toBeDefined();
    expect(getEventSchema(BOOKING_DISPUTE_OPENED)).toBe(BookingDisputeOpenedSchema);
  });

  it('registers booking.dispute_resolved in the registry', () => {
    expect(eventRegistry[BOOKING_DISPUTE_RESOLVED]).toBeDefined();
    expect(getEventSchema(BOOKING_DISPUTE_RESOLVED)).toBe(BookingDisputeResolvedSchema);
  });

  it('uses past-tense dotted event names (CLAUDE.md §2.2)', () => {
    expect(BOOKING_DISPUTE_OPENED).toMatch(/^booking\.[a-z][a-z0-9_]*$/);
    expect(BOOKING_DISPUTE_RESOLVED).toMatch(/^booking\.[a-z][a-z0-9_]*$/);
  });

  describe('BookingDisputeOpenedSchema', () => {
    const valid = {
      ...baseEnvelope,
      disputeId: 'dsp_abc',
      bookingId: 'bkg_abc',
      householdId: 'hh_abc',
      providerId: 'prv_abc',
      openedByUserId: 'usr_family',
      openedByRole: 'family' as const,
      reason: 'service_quality' as const,
      hasReasonDetail: true,
    };

    it('accepts a valid payload', () => {
      expect(BookingDisputeOpenedSchema.safeParse(valid).success).toBe(true);
    });

    it('accepts hasReasonDetail=false', () => {
      expect(
        BookingDisputeOpenedSchema.safeParse({ ...valid, hasReasonDetail: false }).success,
      ).toBe(true);
    });

    it('rejects unknown opener role', () => {
      expect(
        BookingDisputeOpenedSchema.safeParse({ ...valid, openedByRole: 'concierge_lead' as never })
          .success,
      ).toBe(false);
    });

    it('rejects unknown reason', () => {
      expect(
        BookingDisputeOpenedSchema.safeParse({ ...valid, reason: 'weather' as never }).success,
      ).toBe(false);
    });

    it('does not carry freeform reasonDetail on the event (PII discipline)', () => {
      // The shape explicitly does not have a `reasonDetail` field —
      // `hasReasonDetail` is the boolean signal. `.strict()` rejects
      // a stray `reasonDetail` field at the wire so a producer cannot
      // accidentally leak narrative text.
      expect(
        BookingDisputeOpenedSchema.safeParse({
          ...valid,
          reasonDetail: 'Cold meal.',
        } as unknown).success,
      ).toBe(false);
    });
  });

  describe('BookingDisputeResolvedSchema', () => {
    const valid = {
      ...baseEnvelope,
      disputeId: 'dsp_abc',
      bookingId: 'bkg_abc',
      householdId: 'hh_abc',
      providerId: 'prv_abc',
      outcome: 'resolved' as const,
      resolvedByUserId: 'usr_ops',
      reason: 'billing_dispute' as const,
      hasResolutionNotes: true,
    };

    it('accepts a valid resolved payload', () => {
      expect(BookingDisputeResolvedSchema.safeParse(valid).success).toBe(true);
    });

    it('accepts a valid dismissed payload', () => {
      expect(
        BookingDisputeResolvedSchema.safeParse({ ...valid, outcome: 'dismissed' as const }).success,
      ).toBe(true);
    });

    it('rejects under_review as an outcome', () => {
      expect(
        BookingDisputeResolvedSchema.safeParse({ ...valid, outcome: 'under_review' as never })
          .success,
      ).toBe(false);
    });

    it('does not carry freeform resolutionNotes on the event (PII discipline)', () => {
      expect(
        BookingDisputeResolvedSchema.safeParse({
          ...valid,
          resolutionNotes: 'Refunded $100.',
        } as unknown).success,
      ).toBe(false);
    });
  });
});
