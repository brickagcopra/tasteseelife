import { describe, expect, it } from 'vitest';

import {
  BOOKING_HOLD_LIMIT_DEFAULT,
  BOOKING_HOLD_LIMIT_MAX,
  BOOKING_HOLD_OFFSET_MAX,
  BookingHoldListResponseSchema,
  BookingHoldRowSchema,
  ListBookingHoldsQuerySchema,
} from '../http/booking-holds.schema';

/**
 * Contract tests for the admin booking-hold read (TS-304-followup-3).
 *
 * The load-bearing assertions:
 *   - `subjectId` without `subjectKind` is rejected — a bare id search
 *     would match across three different services' id spaces;
 *   - `status` defaults to `active`, the operational question;
 *   - the booking count is per-INCIDENT and the field name carries that,
 *     so a consumer that sums three rows of one incident is visibly
 *     doing something the contract named against;
 *   - `severity` / `category` are plain strings — snapshots of what
 *     trust & safety said at hold time, not the live enum.
 */

const ROW = {
  id: 'bsh_1',
  incidentId: 'inc_1',
  subjectKind: 'provider',
  subjectId: 'prov_1',
  severity: 'high',
  category: 'safety',
  heldAt: '2026-07-20T10:00:00.000Z',
  releasedAt: null,
  incidentSuspendedBookingCount: 4,
} as const;

describe('BookingHoldRowSchema', () => {
  it('accepts an active hold row', () => {
    expect(BookingHoldRowSchema.parse(ROW)).toEqual(ROW);
  });

  it('accepts a released hold row', () => {
    const parsed = BookingHoldRowSchema.parse({
      ...ROW,
      releasedAt: '2026-07-24T09:00:00.000Z',
      incidentSuspendedBookingCount: 0,
    });
    expect(parsed.releasedAt).toBe('2026-07-24T09:00:00.000Z');
  });

  it('accepts a zero booking count — a held provider with no visits interrupts no care', () => {
    expect(
      BookingHoldRowSchema.safeParse({ ...ROW, incidentSuspendedBookingCount: 0 }).success,
    ).toBe(true);
  });

  it('rejects a negative booking count', () => {
    expect(
      BookingHoldRowSchema.safeParse({ ...ROW, incidentSuspendedBookingCount: -1 }).success,
    ).toBe(false);
  });

  it('accepts every subject kind and rejects an unknown one', () => {
    for (const kind of ['provider', 'senior', 'household']) {
      expect(BookingHoldRowSchema.safeParse({ ...ROW, subjectKind: kind }).success).toBe(true);
    }
    expect(BookingHoldRowSchema.safeParse({ ...ROW, subjectKind: 'partner' }).success).toBe(false);
  });

  it('accepts a severity value the trust-safety enum does not have today', () => {
    // The snapshot must stay readable when the incident enum grows; a
    // hold taken last year is not invalidated by a new severity level.
    expect(BookingHoldRowSchema.safeParse({ ...ROW, severity: 'catastrophic' }).success).toBe(true);
  });

  it('rejects an unknown key', () => {
    expect(BookingHoldRowSchema.safeParse({ ...ROW, subjectBookingCount: 2 }).success).toBe(false);
  });
});

describe('ListBookingHoldsQuerySchema', () => {
  it('defaults to active holds with the standard page', () => {
    expect(ListBookingHoldsQuerySchema.parse({})).toEqual({
      status: 'active',
      limit: BOOKING_HOLD_LIMIT_DEFAULT,
      offset: 0,
    });
  });

  it('accepts released and all', () => {
    expect(ListBookingHoldsQuerySchema.parse({ status: 'released' }).status).toBe('released');
    expect(ListBookingHoldsQuerySchema.parse({ status: 'all' }).status).toBe('all');
  });

  it('REJECTS subjectId without subjectKind', () => {
    const result = ListBookingHoldsQuerySchema.safeParse({ subjectId: 'prov_1' });
    expect(result.success).toBe(false);
  });

  it('accepts subjectId together with subjectKind', () => {
    const parsed = ListBookingHoldsQuerySchema.parse({
      subjectKind: 'provider',
      subjectId: 'prov_1',
    });
    expect(parsed.subjectId).toBe('prov_1');
  });

  it('accepts subjectKind alone — "every held provider" is a real question', () => {
    expect(ListBookingHoldsQuerySchema.safeParse({ subjectKind: 'senior' }).success).toBe(true);
  });

  it('coerces limit and offset from query-string strings', () => {
    const parsed = ListBookingHoldsQuerySchema.parse({ limit: '10', offset: '20' });
    expect(parsed.limit).toBe(10);
    expect(parsed.offset).toBe(20);
  });

  it('rejects an over-cap limit and a deep offset', () => {
    expect(
      ListBookingHoldsQuerySchema.safeParse({ limit: BOOKING_HOLD_LIMIT_MAX + 1 }).success,
    ).toBe(false);
    expect(
      ListBookingHoldsQuerySchema.safeParse({ offset: BOOKING_HOLD_OFFSET_MAX + 1 }).success,
    ).toBe(false);
  });

  it('rejects an unknown filter key', () => {
    expect(ListBookingHoldsQuerySchema.safeParse({ severity: 'high' }).success).toBe(false);
  });
});

describe('BookingHoldListResponseSchema', () => {
  it('accepts a populated page and echoes the applied paging', () => {
    const parsed = BookingHoldListResponseSchema.parse({
      holds: [ROW],
      total: 12,
      limit: 50,
      offset: 0,
    });
    expect(parsed.holds).toHaveLength(1);
    expect(parsed.total).toBe(12);
  });

  it('accepts an empty page', () => {
    expect(
      BookingHoldListResponseSchema.safeParse({ holds: [], total: 0, limit: 50, offset: 0 })
        .success,
    ).toBe(true);
  });

  it('rejects an unknown top-level key', () => {
    expect(
      BookingHoldListResponseSchema.safeParse({
        holds: [],
        total: 0,
        limit: 50,
        offset: 0,
        incidents: [],
      }).success,
    ).toBe(false);
  });
});
