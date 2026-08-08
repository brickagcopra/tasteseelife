import { describe, expect, it } from 'vitest';

import { shouldRunNow, utcDayKey } from './schedule';

describe('utcDayKey', () => {
  it('formats the UTC calendar date', () => {
    expect(utcDayKey(new Date('2026-05-28T02:00:00Z'))).toBe('2026-05-28');
    expect(utcDayKey(new Date('2026-01-05T23:59:59Z'))).toBe('2026-01-05');
  });

  it('uses UTC, not local time', () => {
    // 2026-05-28T23:30 UTC stays on the 28th regardless of host TZ.
    expect(utcDayKey(new Date('2026-05-28T23:30:00Z'))).toBe('2026-05-28');
  });
});

describe('shouldRunNow', () => {
  const runHourUtc = 2;

  it('returns false before the run hour', () => {
    expect(
      shouldRunNow({
        now: new Date('2026-05-28T01:59:00Z'),
        runHourUtc,
        lastRunDayKey: undefined,
      }),
    ).toBe(false);
  });

  it('returns true at the run hour when the day has not run', () => {
    expect(
      shouldRunNow({
        now: new Date('2026-05-28T02:00:00Z'),
        runHourUtc,
        lastRunDayKey: undefined,
      }),
    ).toBe(true);
  });

  it('returns true later in the day if the day has not run yet', () => {
    expect(
      shouldRunNow({
        now: new Date('2026-05-28T18:00:00Z'),
        runHourUtc,
        lastRunDayKey: '2026-05-27',
      }),
    ).toBe(true);
  });

  it('returns false when this day already ran', () => {
    expect(
      shouldRunNow({
        now: new Date('2026-05-28T03:00:00Z'),
        runHourUtc,
        lastRunDayKey: '2026-05-28',
      }),
    ).toBe(false);
  });

  it('returns true on the next day after the prior day ran', () => {
    expect(
      shouldRunNow({
        now: new Date('2026-05-29T02:30:00Z'),
        runHourUtc,
        lastRunDayKey: '2026-05-28',
      }),
    ).toBe(true);
  });
});
