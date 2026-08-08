import { describe, expect, it } from 'vitest';

import { classifyRenewalCandidate, resolveDailyPeriod, shouldRunNow } from './schedule';

const DAY = 86_400_000;
const NOW = new Date('2026-06-08T14:30:00.000Z');

function isoDaysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * DAY).toISOString();
}

describe('resolveDailyPeriod', () => {
  it('keys the run by the UTC calendar day', () => {
    expect(resolveDailyPeriod(new Date('2026-06-08T14:30:00.000Z')).periodKey).toBe('2026-06-08');
    expect(resolveDailyPeriod(new Date('2026-12-01T00:00:00.000Z')).periodKey).toBe('2026-12-01');
  });
});

describe('shouldRunNow', () => {
  it('is false before the run hour', () => {
    expect(
      shouldRunNow({
        now: new Date('2026-06-08T13:59:59.000Z'),
        runHourUtc: 14,
        lastRunPeriod: undefined,
      }),
    ).toBe(false);
  });

  it('is true at/after the run hour when the day has not run', () => {
    expect(shouldRunNow({ now: NOW, runHourUtc: 14, lastRunPeriod: undefined })).toBe(true);
    expect(shouldRunNow({ now: NOW, runHourUtc: 14, lastRunPeriod: '2026-06-07' })).toBe(true);
  });

  it('is false once the same UTC day has already run', () => {
    expect(shouldRunNow({ now: NOW, runHourUtc: 14, lastRunPeriod: '2026-06-08' })).toBe(false);
  });
});

describe('classifyRenewalCandidate', () => {
  it('classifies an already-past expiry as lapsed', () => {
    expect(classifyRenewalCandidate(isoDaysFromNow(-1), NOW)).toEqual({ kind: 'lapsed' });
    expect(classifyRenewalCandidate(NOW.toISOString(), NOW)).toEqual({ kind: 'lapsed' });
  });

  it('maps a future expiry to its reminder milestone', () => {
    expect(classifyRenewalCandidate(isoDaysFromNow(90), NOW)).toEqual({
      kind: 'reminder',
      daysUntilExpiry: 90,
      milestoneDays: 90,
    });
    expect(classifyRenewalCandidate(isoDaysFromNow(45), NOW)).toEqual({
      kind: 'reminder',
      daysUntilExpiry: 45,
      milestoneDays: 60,
    });
    expect(classifyRenewalCandidate(isoDaysFromNow(7), NOW)).toEqual({
      kind: 'reminder',
      daysUntilExpiry: 7,
      milestoneDays: 7,
    });
  });

  it('skips a future expiry beyond the 90-day window', () => {
    expect(classifyRenewalCandidate(isoDaysFromNow(120), NOW)).toEqual({
      kind: 'skip',
      daysUntilExpiry: 120,
    });
  });

  it('skips a sub-day future expiry (no milestone, not yet lapsed)', () => {
    // ~12h out: floor of the day diff is 0, which is below the 7-day floor.
    expect(classifyRenewalCandidate(isoDaysFromNow(0.5), NOW)).toEqual({
      kind: 'skip',
      daysUntilExpiry: 0,
    });
  });

  it('skips a malformed timestamp rather than crashing', () => {
    const result = classifyRenewalCandidate('not-a-date', NOW);
    expect(result.kind).toBe('skip');
  });
});
