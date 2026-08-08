import { describe, expect, it } from 'vitest';

import {
  BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL,
  BOOKING_ANOMALY_MASS_CANCELLATION,
  BookingAnomalyImpossibleTravelSchema,
  BookingAnomalyMassCancellationSchema,
  BookingAnomalySubjectKindSchema,
  getEventSchema,
} from '../events';

/**
 * Contract tests for the two anomaly-detection events service-booking
 * emits (TS-308a impossible travel, TS-308c mass cancellation).
 *
 * The impossible-travel half had NO contract test when TS-308c landed —
 * added here rather than left, since both events share one refusal that
 * is the whole reason they are shaped the way they are: **nothing that
 * identifies where a senior lives, or what a family said, crosses the
 * wire.** `.strict()` is what enforces it, so the "rejects unknown
 * fields" cases below are not boilerplate — they are the test that a
 * later change cannot quietly bolt a coordinate or a reason string onto
 * a payload every consumer logs.
 */

const validImpossibleTravel = {
  eventId: 'impossible-travel:ci_prev:ci_curr',
  occurredAt: '2026-07-26T10:05:00.000Z',
  providerId: 'prv_abc',
  previousCheckInId: 'ci_prev',
  checkInId: 'ci_curr',
  previousBookingId: 'bkg_prev',
  bookingId: 'bkg_curr',
  distanceMeters: 812_000,
  elapsedSeconds: 3_900,
  impliedSpeedKph: 749.5,
  thresholdKph: 1_000,
  previousOccurredAt: '2026-07-26T09:00:00.000Z',
};

const validMassCancellation = {
  eventId: 'mass-cancellation:provider:prv_abc:2026-07-26',
  occurredAt: '2026-07-26T18:00:00.000Z',
  subjectKind: 'provider' as const,
  subjectId: 'prv_abc',
  windowStart: '2026-07-25T18:00:00.000Z',
  windowEnd: '2026-07-26T18:00:00.000Z',
  windowBucket: '2026-07-26',
  canceledBookingCount: 9,
  distinctCancellationCount: 6,
  threshold: 5,
  distinctActorCount: 1,
  unattributedCount: 0,
  staffExcludedCount: 0,
};

describe('BookingAnomalyImpossibleTravelSchema', () => {
  it('accepts a well-formed finding', () => {
    expect(BookingAnomalyImpossibleTravelSchema.safeParse(validImpossibleTravel).success).toBe(
      true,
    );
  });

  it('is registered under its event name', () => {
    expect(getEventSchema(BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL)).toBe(
      BookingAnomalyImpossibleTravelSchema,
    );
  });

  it('rejects a payload carrying coordinates', () => {
    // The load-bearing case: a check-in location is a senior's home
    // address in decimal form (CLAUDE.md §12), and `.strict()` is what
    // stops a future change putting it back on the wire "for triage".
    const result = BookingAnomalyImpossibleTravelSchema.safeParse({
      ...validImpossibleTravel,
      latitude: 40.7128,
      longitude: -74.006,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a zero elapsed interval', () => {
    // Two check-ins sharing a timestamp are a clock problem, not a
    // travel claim; the producer screens them out rather than
    // manufacturing an infinite speed.
    expect(
      BookingAnomalyImpossibleTravelSchema.safeParse({
        ...validImpossibleTravel,
        elapsedSeconds: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-positive threshold', () => {
    expect(
      BookingAnomalyImpossibleTravelSchema.safeParse({
        ...validImpossibleTravel,
        thresholdKph: 0,
      }).success,
    ).toBe(false);
  });
});

describe('BookingAnomalySubjectKindSchema', () => {
  it('admits exactly the two subjects the booking row can name without a cross-service lookup', () => {
    expect(BookingAnomalySubjectKindSchema.options).toEqual(['provider', 'household']);
  });

  it('rejects `senior` — a senior’s visits are a subset of the household’s', () => {
    expect(BookingAnomalySubjectKindSchema.safeParse('senior').success).toBe(false);
  });
});

describe('BookingAnomalyMassCancellationSchema', () => {
  it('accepts a well-formed provider finding', () => {
    expect(BookingAnomalyMassCancellationSchema.safeParse(validMassCancellation).success).toBe(
      true,
    );
  });

  it('accepts a household finding', () => {
    expect(
      BookingAnomalyMassCancellationSchema.safeParse({
        ...validMassCancellation,
        subjectKind: 'household',
        subjectId: 'hh_abc',
      }).success,
    ).toBe(true);
  });

  it('is registered under its event name', () => {
    expect(getEventSchema(BOOKING_ANOMALY_MASS_CANCELLATION)).toBe(
      BookingAnomalyMassCancellationSchema,
    );
  });

  it('rejects a cancellation reason breakdown', () => {
    // Reasons are categorical and would be useful triage colour, and
    // they are deliberately absent: a per-row reason says something
    // about a named senior's circumstances.
    expect(
      BookingAnomalyMassCancellationSchema.safeParse({
        ...validMassCancellation,
        reasons: { welfare_concern: 3, family_request: 6 },
      }).success,
    ).toBe(false);
  });

  it('rejects free text', () => {
    expect(
      BookingAnomalyMassCancellationSchema.safeParse({
        ...validMassCancellation,
        description: 'provider walked off the job',
      }).success,
    ).toBe(false);
  });

  it('rejects a bucket that is not a bare UTC date', () => {
    // The bucket is half the deterministic event id. A timestamp here
    // would make every sweep tick a new id, and one subject would open
    // an incident every fifteen minutes.
    for (const bucket of ['2026-07-26T00:00:00.000Z', '26-07-2026', '2026-7-26', '']) {
      expect(
        BookingAnomalyMassCancellationSchema.safeParse({
          ...validMassCancellation,
          windowBucket: bucket,
        }).success,
      ).toBe(false);
    }
  });

  it('rejects a breach of zero', () => {
    expect(
      BookingAnomalyMassCancellationSchema.safeParse({
        ...validMassCancellation,
        distinctCancellationCount: 0,
      }).success,
    ).toBe(false);
    expect(
      BookingAnomalyMassCancellationSchema.safeParse({
        ...validMassCancellation,
        canceledBookingCount: 0,
      }).success,
    ).toBe(false);
  });

  it('allows zero distinct actors and a non-zero unattributed count', () => {
    // Every row in the window predates the `canceled_by_user_id`
    // column. The finding is still real; the actor colour is simply
    // unavailable, and the reviewer must be able to see that rather
    // than read "0 actors" as "nobody did this".
    expect(
      BookingAnomalyMassCancellationSchema.safeParse({
        ...validMassCancellation,
        distinctActorCount: 0,
        unattributedCount: 9,
        staffExcludedCount: 0,
      }).success,
    ).toBe(true);
  });

  it('carries the staff-excluded count, which may exceed every other count', () => {
    // TS-308c-followup-3. Ops closing out a departed provider's calendar
    // is the case this field exists for: a handful of real cancellations
    // beside a much larger number that were ours. The reviewer has to be
    // able to see both, so nothing here caps or relates the two.
    expect(
      BookingAnomalyMassCancellationSchema.safeParse({
        ...validMassCancellation,
        canceledBookingCount: 5,
        distinctCancellationCount: 5,
        staffExcludedCount: 40,
      }).success,
    ).toBe(true);
  });

  it('requires the staff-excluded count — a missing one would read as zero', () => {
    const { staffExcludedCount: _omitted, ...withoutIt } = validMassCancellation;

    expect(BookingAnomalyMassCancellationSchema.safeParse(withoutIt).success).toBe(false);
  });

  it('rejects an unknown subject kind', () => {
    expect(
      BookingAnomalyMassCancellationSchema.safeParse({
        ...validMassCancellation,
        subjectKind: 'senior' as never,
      }).success,
    ).toBe(false);
  });
});
