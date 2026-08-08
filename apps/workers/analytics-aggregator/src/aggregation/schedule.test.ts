import { describe, expect, it } from 'vitest';

import { previousUtcDayKey, shouldRunNow, startOfUtcDayIso, utcDayKey } from './schedule';

describe('utcDayKey', () => {
  it('formats the UTC calendar date', () => {
    expect(utcDayKey(new Date('2026-06-09T03:00:00Z'))).toBe('2026-06-09');
    expect(utcDayKey(new Date('2026-01-05T23:59:59Z'))).toBe('2026-01-05');
  });

  it('uses UTC, not local time', () => {
    expect(utcDayKey(new Date('2026-06-09T23:30:00Z'))).toBe('2026-06-09');
  });
});

describe('previousUtcDayKey', () => {
  it('returns the day before the asOf date', () => {
    expect(previousUtcDayKey(new Date('2026-06-09T03:00:00Z'))).toBe('2026-06-08');
  });

  it('is independent of the time-of-day', () => {
    expect(previousUtcDayKey(new Date('2026-06-09T00:05:00Z'))).toBe('2026-06-08');
    expect(previousUtcDayKey(new Date('2026-06-09T23:55:00Z'))).toBe('2026-06-08');
  });

  it('crosses a month boundary correctly', () => {
    expect(previousUtcDayKey(new Date('2026-03-01T03:00:00Z'))).toBe('2026-02-28');
  });
});

describe('startOfUtcDayIso', () => {
  it('returns the start-of-day ISO instant', () => {
    expect(startOfUtcDayIso('2026-06-08')).toBe('2026-06-08T00:00:00.000Z');
  });
});

describe('shouldRunNow', () => {
  const runHourUtc = 3;

  it('returns false before the run hour', () => {
    expect(
      shouldRunNow({ now: new Date('2026-06-09T02:59:00Z'), runHourUtc, lastRunDayKey: undefined }),
    ).toBe(false);
  });

  it('returns true at the run hour when the day has not run', () => {
    expect(
      shouldRunNow({ now: new Date('2026-06-09T03:00:00Z'), runHourUtc, lastRunDayKey: undefined }),
    ).toBe(true);
  });

  it('returns false when this day already ran', () => {
    expect(
      shouldRunNow({
        now: new Date('2026-06-09T04:00:00Z'),
        runHourUtc,
        lastRunDayKey: '2026-06-09',
      }),
    ).toBe(false);
  });

  it('returns true on the next day after the prior day ran', () => {
    expect(
      shouldRunNow({
        now: new Date('2026-06-10T03:30:00Z'),
        runHourUtc,
        lastRunDayKey: '2026-06-09',
      }),
    ).toBe(true);
  });
});
