import { describe, expect, it } from 'vitest';

import type { PersistedBookingRecurrence } from '../recurrence.service';

import { toBookingRecurrenceRecord } from './recurrence.mapper';

const BASE: PersistedBookingRecurrence = {
  seriesId: 'srs_abc',
  rrule: 'FREQ=WEEKLY;COUNT=4',
  endDate: null,
  count: 4,
  occurrenceCount: 4,
  householdId: 'hh_abc',
  seniorId: 'sr_abc',
  providerId: 'prv_abc',
  createdAt: new Date('2026-05-13T12:00:00.000Z'),
  updatedAt: new Date('2026-05-13T12:00:00.000Z'),
};

describe('toBookingRecurrenceRecord', () => {
  it('emits ISO 8601 timestamps for createdAt + updatedAt', () => {
    const out = toBookingRecurrenceRecord(BASE);
    expect(out.createdAt).toBe('2026-05-13T12:00:00.000Z');
    expect(out.updatedAt).toBe('2026-05-13T12:00:00.000Z');
  });

  it('passes seriesId, rrule, count, occurrenceCount verbatim', () => {
    const out = toBookingRecurrenceRecord(BASE);
    expect(out.seriesId).toBe('srs_abc');
    expect(out.rrule).toBe('FREQ=WEEKLY;COUNT=4');
    expect(out.count).toBe(4);
    expect(out.occurrenceCount).toBe(4);
  });

  it('emits endDate as null when the recurrence used COUNT termination', () => {
    const out = toBookingRecurrenceRecord(BASE);
    expect(out.endDate).toBeNull();
  });

  it('emits endDate as an ISO 8601 string when UNTIL is set', () => {
    const out = toBookingRecurrenceRecord({
      ...BASE,
      count: null,
      endDate: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(out.endDate).toBe('2026-09-01T00:00:00.000Z');
    expect(out.count).toBeNull();
  });
});
