import { describe, expect, it } from 'vitest';

import type { CheckInRecord } from '../services/check-ins.service';
import { toBookingCheckInResponse } from './check-ins.mapper';

/**
 * check-ins.mapper unit suite (TS-063).
 *
 * Verifies the Decimal → JSON number conversion preserves precision
 * within IEEE-754's lossless range for lat/long, that `null` accuracy
 * round-trips correctly, and that timestamps emit as ISO 8601 strings.
 */

function wrapDecimal(value: string): { toString(): string } {
  return { toString: () => value };
}

const SAMPLE: CheckInRecord = {
  id: 'chk_abc',
  bookingId: 'bkg_abc',
  kind: 'check_in',
  latitude: wrapDecimal('40.712812'),
  longitude: wrapDecimal('-74.006099'),
  locationAccuracyMeters: wrapDecimal('8.46'),
  occurredAt: new Date('2026-05-14T18:00:00.000Z'),
  recordedByUserId: 'usr_provider',
  createdAt: new Date('2026-05-14T18:00:00.000Z'),
  updatedAt: new Date('2026-05-14T18:00:00.000Z'),
};

describe('toBookingCheckInResponse', () => {
  it('maps a complete row to the response DTO shape', () => {
    const out = toBookingCheckInResponse(SAMPLE);
    expect(out.id).toBe('chk_abc');
    expect(out.bookingId).toBe('bkg_abc');
    expect(out.kind).toBe('check_in');
    expect(out.latitude).toBeCloseTo(40.712812, 6);
    expect(out.longitude).toBeCloseTo(-74.006099, 6);
    expect(out.locationAccuracyMeters).toBeCloseTo(8.46, 2);
    expect(out.occurredAt).toBe('2026-05-14T18:00:00.000Z');
    expect(out.recordedByUserId).toBe('usr_provider');
    expect(out.createdAt).toBe('2026-05-14T18:00:00.000Z');
    expect(out.updatedAt).toBe('2026-05-14T18:00:00.000Z');
  });

  it('emits null accuracy when the column is null', () => {
    const out = toBookingCheckInResponse({ ...SAMPLE, locationAccuracyMeters: null });
    expect(out.locationAccuracyMeters).toBeNull();
  });

  it('preserves negative longitude / latitude signs', () => {
    const out = toBookingCheckInResponse({
      ...SAMPLE,
      latitude: wrapDecimal('-33.865143'),
      longitude: wrapDecimal('151.209900'),
    });
    expect(out.latitude).toBeCloseTo(-33.865143, 6);
    expect(out.longitude).toBeCloseTo(151.2099, 6);
  });

  it('handles the zero coordinate edge case', () => {
    const out = toBookingCheckInResponse({
      ...SAMPLE,
      latitude: wrapDecimal('0.000000'),
      longitude: wrapDecimal('0.000000'),
    });
    expect(out.latitude).toBe(0);
    expect(out.longitude).toBe(0);
  });
});
