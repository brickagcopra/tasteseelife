import { describe, expect, it } from 'vitest';
import type {
  AdminPausedDeferredRevenueBalance,
  AdminPausedDeferredRevenueResponse,
} from '@taste-and-see/contracts';

import { describePausedBalance, describePausedQueue } from '@/lib/paused-balances';

const BALANCE: AdminPausedDeferredRevenueBalance = {
  balanceId: 'drb_1',
  subscriptionId: 'sub_1',
  customerId: 'hh_1',
  customerGroup: 'family',
  planCode: 'family.tier2',
  currency: 'USD',
  pausedAt: '2026-05-01T00:00:00.000Z',
  pausedForSeconds: 90_000,
  priorPausedSeconds: 0,
  servicePeriodStart: '2026-04-01T00:00:00.000Z',
  servicePeriodEnd: '2026-05-15T00:00:00.000Z',
  pastServicePeriodEnd: false,
  originalAmountMinor: 29_900,
  recognizedAmountMinor: 12_000,
  remainingDeferredMinor: 17_900,
};

const QUEUE: AdminPausedDeferredRevenueResponse = {
  asOf: '2026-06-01T00:00:00.000Z',
  summary: {
    pausedCount: 1,
    pastServicePeriodEndCount: 0,
    unknownPausedAtCount: 0,
    oldestPausedAt: '2026-05-01T00:00:00.000Z',
    totalRemainingDeferredMinor: 17_900,
    currency: 'USD',
  },
  balances: [BALANCE],
  truncated: false,
};

describe('describePausedBalance', () => {
  it('rounds a duration DOWN to its largest whole unit', () => {
    // 25 hours is "1d", not "1d 1h" and not "1 day" rounded up from 23h —
    // the figure is read as "at least this long".
    expect(describePausedBalance({ ...BALANCE, pausedForSeconds: 90_000 }).age).toBe('1d');
    expect(describePausedBalance({ ...BALANCE, pausedForSeconds: 82_800 }).age).toBe('23h');
  });

  it('scales through seconds, minutes and hours', () => {
    expect(describePausedBalance({ ...BALANCE, pausedForSeconds: 45 }).age).toBe('45s');
    expect(describePausedBalance({ ...BALANCE, pausedForSeconds: 3_599 }).age).toBe('59m');
    expect(describePausedBalance({ ...BALANCE, pausedForSeconds: 3_600 }).age).toBe('1h');
  });

  it('reports a null age — never zero — when the pause instant was never recorded', () => {
    const described = describePausedBalance({
      ...BALANCE,
      pausedAt: null,
      pausedForSeconds: null,
    });
    // The page renders this as an explicit warning chip rather than a
    // duration; a "0s" here would put the least diagnosable row at the
    // bottom of an age-sorted reading.
    expect(described.age).toBeNull();
  });

  it('reports a genuinely fresh pause as zero seconds, not as unknown', () => {
    expect(describePausedBalance({ ...BALANCE, pausedForSeconds: 0 }).age).toBe('0s');
  });
});

describe('describePausedQueue', () => {
  it('says nothing when the queue is unambiguous', () => {
    // An unconditional caveat that is usually false trains people to skip
    // the caveats that are not.
    expect(describePausedQueue(QUEUE).notes).toEqual([]);
  });

  it('states that the totals cover more than the rows when truncated', () => {
    const notes = describePausedQueue({
      ...QUEUE,
      summary: { ...QUEUE.summary, pausedCount: 900 },
      truncated: true,
    }).notes;

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('900');
    expect(notes[0]).toContain('cover all of them');
  });

  it('flags balances whose age cannot be established', () => {
    const notes = describePausedQueue({
      ...QUEUE,
      summary: { ...QUEUE.summary, unknownPausedAtCount: 2, oldestPausedAt: null },
    }).notes;

    expect(notes.some((n) => n.includes('no recorded pause instant'))).toBe(true);
    expect(notes.some((n) => n.includes('oldest-pause figure'))).toBe(true);
  });

  it('flags balances past their own service period end', () => {
    const notes = describePausedQueue({
      ...QUEUE,
      summary: { ...QUEUE.summary, pastServicePeriodEndCount: 1 },
    }).notes;

    expect(notes.some((n) => n.includes('past the end of the service period'))).toBe(true);
    // States what was measured and why it matters; never calls it a defect.
    expect(notes.join(' ')).not.toMatch(/broken|bug|failure/i);
  });

  it('agrees in number for one balance and for many', () => {
    const one = describePausedQueue({
      ...QUEUE,
      summary: { ...QUEUE.summary, pastServicePeriodEndCount: 1 },
    }).notes.join(' ');
    const many = describePausedQueue({
      ...QUEUE,
      summary: { ...QUEUE.summary, pastServicePeriodEndCount: 4 },
    }).notes.join(' ');

    expect(one).toContain('1 balance is past');
    expect(many).toContain('4 balances are past');
  });

  it('carries every applicable caveat at once', () => {
    const notes = describePausedQueue({
      ...QUEUE,
      summary: {
        ...QUEUE.summary,
        pausedCount: 40,
        unknownPausedAtCount: 1,
        pastServicePeriodEndCount: 3,
      },
      truncated: true,
    }).notes;

    expect(notes).toHaveLength(3);
  });
});
