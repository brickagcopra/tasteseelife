import { describe, expect, it } from 'vitest';

import { resolvePeriod, shouldRunNow } from './schedule';

describe('resolvePeriod', () => {
  it('keys on the run month and labels the prior month', () => {
    const { periodKey, periodLabel } = resolvePeriod(new Date('2026-05-01T13:00:00.000Z'));
    expect(periodKey).toBe('2026-05');
    expect(periodLabel).toBe('April 2026');
  });

  it('rolls a January run back to the prior December', () => {
    const { periodKey, periodLabel } = resolvePeriod(new Date('2026-01-01T13:00:00.000Z'));
    expect(periodKey).toBe('2026-01');
    expect(periodLabel).toBe('December 2025');
  });
});

describe('shouldRunNow', () => {
  const base = {
    runDayOfMonth: 1,
    runHourUtc: 13,
    lastRunPeriod: undefined as string | undefined,
  };

  it('is true at/after the window when the period has not run', () => {
    expect(shouldRunNow({ ...base, now: new Date('2026-05-01T13:00:00.000Z') })).toBe(true);
    expect(shouldRunNow({ ...base, now: new Date('2026-05-02T08:00:00.000Z') })).toBe(true);
  });

  it('is false before the run hour on the run day', () => {
    expect(shouldRunNow({ ...base, now: new Date('2026-05-01T12:59:00.000Z') })).toBe(false);
  });

  it('is false before the run day', () => {
    expect(
      shouldRunNow({ ...base, runDayOfMonth: 15, now: new Date('2026-05-14T23:00:00.000Z') }),
    ).toBe(false);
  });

  it('is false once the period has already run', () => {
    expect(
      shouldRunNow({
        ...base,
        lastRunPeriod: '2026-05',
        now: new Date('2026-05-01T13:30:00.000Z'),
      }),
    ).toBe(false);
  });

  it('runs again the next month after a prior run', () => {
    expect(
      shouldRunNow({
        ...base,
        lastRunPeriod: '2026-05',
        now: new Date('2026-06-01T13:00:00.000Z'),
      }),
    ).toBe(true);
  });
});
