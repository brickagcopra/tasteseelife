import { describe, expect, it } from 'vitest';

import { shouldRunNow, utcDayKey } from './schedule';

describe('utcDayKey', () => {
  it('formats a Date as its UTC calendar date', () => {
    expect(utcDayKey(new Date('2026-05-29T03:00:00.000Z'))).toBe('2026-05-29');
    expect(utcDayKey(new Date('2026-01-05T23:59:59.000Z'))).toBe('2026-01-05');
  });
});

describe('shouldRunNow', () => {
  it('returns false before the run hour', () => {
    expect(
      shouldRunNow({
        now: new Date('2026-05-29T02:00:00Z'),
        runHourUtc: 3,
        lastRunDayKey: undefined,
      }),
    ).toBe(false);
  });

  it('returns true at/after the run hour when the day has not run', () => {
    expect(
      shouldRunNow({
        now: new Date('2026-05-29T03:30:00Z'),
        runHourUtc: 3,
        lastRunDayKey: undefined,
      }),
    ).toBe(true);
  });

  it('returns false when the day already ran', () => {
    expect(
      shouldRunNow({
        now: new Date('2026-05-29T05:00:00Z'),
        runHourUtc: 3,
        lastRunDayKey: '2026-05-29',
      }),
    ).toBe(false);
  });

  it('returns true on a new day even if a prior day ran', () => {
    expect(
      shouldRunNow({
        now: new Date('2026-05-30T03:00:00Z'),
        runHourUtc: 3,
        lastRunDayKey: '2026-05-29',
      }),
    ).toBe(true);
  });
});
