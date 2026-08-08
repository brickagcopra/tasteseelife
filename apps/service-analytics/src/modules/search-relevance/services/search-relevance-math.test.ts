import { describe, expect, it } from 'vitest';

import {
  countAttributedBookings,
  impressionsForPositions,
  rateToPpm,
  toUtcDayWindow,
  utcDateKey,
} from './search-relevance-math';

describe('utcDateKey', () => {
  it('formats the UTC calendar date', () => {
    expect(utcDateKey(new Date('2026-06-08T03:00:00Z'))).toBe('2026-06-08');
    expect(utcDateKey(new Date('2026-01-05T23:59:59Z'))).toBe('2026-01-05');
  });

  it('uses UTC, not local time', () => {
    expect(utcDateKey(new Date('2026-06-08T23:30:00Z'))).toBe('2026-06-08');
  });
});

describe('toUtcDayWindow', () => {
  it('returns the half-open [00:00, next-00:00) window for the asOf date', () => {
    const window = toUtcDayWindow(new Date('2026-06-08T14:37:00Z'));

    expect(window.dateKey).toBe('2026-06-08');
    expect(window.dayStart.toISOString()).toBe('2026-06-08T00:00:00.000Z');
    expect(window.dayEnd.toISOString()).toBe('2026-06-09T00:00:00.000Z');
  });

  it('snaps a start-of-day asOf to the same window', () => {
    const window = toUtcDayWindow(new Date('2026-06-08T00:00:00.000Z'));

    expect(window.dayStart.toISOString()).toBe('2026-06-08T00:00:00.000Z');
    expect(window.dayEnd.toISOString()).toBe('2026-06-09T00:00:00.000Z');
  });

  it('crosses a month boundary correctly', () => {
    const window = toUtcDayWindow(new Date('2026-01-31T12:00:00Z'));

    expect(window.dateKey).toBe('2026-01-31');
    expect(window.dayEnd.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('rateToPpm', () => {
  it('returns the rate in parts-per-million', () => {
    expect(rateToPpm(18, 120)).toBe(150_000); // 0.15
    expect(rateToPpm(6, 40)).toBe(150_000);
    expect(rateToPpm(1, 1)).toBe(1_000_000); // 1.0
  });

  it('rounds to the nearest ppm', () => {
    expect(rateToPpm(1, 3)).toBe(333_333); // 0.33333... → 333333
  });

  it('returns null for a zero denominator (undefined rate)', () => {
    expect(rateToPpm(0, 0)).toBeNull();
    expect(rateToPpm(5, 0)).toBeNull();
  });

  it('handles a conversion rate above 1.0 (more bookings than searchers)', () => {
    expect(rateToPpm(80, 40)).toBe(2_000_000); // 2.0
  });
});

describe('impressionsForPositions', () => {
  // 6 first-page searches returned 1 hit; 4 returned 5 hits.
  const buckets = [
    { resultCount: 1, searchCount: 6 },
    { resultCount: 5, searchCount: 4 },
  ];

  it('counts a position as an impression when result_count > position', () => {
    const impressions = impressionsForPositions(buckets, [0, 2, 4]);

    expect(impressions.get(0)).toBe(10); // all 10 searches rendered position 0
    expect(impressions.get(2)).toBe(4); // only the 4 with result_count 5 > 2
    expect(impressions.get(4)).toBe(4); // result_count 5 > 4, the 1-hit group excluded
  });

  it('returns zero for a position no search rendered', () => {
    // result_count 5 is NOT > 5, so position 5 was never shown.
    expect(impressionsForPositions(buckets, [5, 9]).get(5)).toBe(0);
    expect(impressionsForPositions(buckets, [5, 9]).get(9)).toBe(0);
  });

  it('returns zero for every position when the histogram is empty', () => {
    const impressions = impressionsForPositions([], [0, 3]);

    expect(impressions.get(0)).toBe(0);
    expect(impressions.get(3)).toBe(0);
  });

  it('returns an empty map when no positions are requested', () => {
    expect(impressionsForPositions(buckets, []).size).toBe(0);
  });
});

describe('countAttributedBookings', () => {
  it('counts bookings whose search_id matches a same-window search event', () => {
    const bookingSearchIds = ['s1', 's2', 's3'];
    const searchEventIds = ['s1', 's2', 'sX'];

    // s1 + s2 match; s3 has no same-window search.
    expect(countAttributedBookings(bookingSearchIds, searchEventIds)).toBe(2);
  });

  it('excludes null / undefined tokens (bookings that did not arrive from a search)', () => {
    const bookingSearchIds = ['s1', null, undefined, 's1'];
    expect(countAttributedBookings(bookingSearchIds, ['s1'])).toBe(2);
  });

  it('counts each booking independently when two share one search_id', () => {
    expect(countAttributedBookings(['s1', 's1'], ['s1'])).toBe(2);
  });

  it('returns zero when no booking token matches', () => {
    expect(countAttributedBookings(['s1', 's2'], ['sX'])).toBe(0);
    expect(countAttributedBookings([], ['s1'])).toBe(0);
    expect(countAttributedBookings(['s1'], [])).toBe(0);
  });
});
