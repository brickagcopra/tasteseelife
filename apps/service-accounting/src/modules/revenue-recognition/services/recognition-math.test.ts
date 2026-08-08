import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';

import {
  asOfDailySuffix,
  computeRecognitionDelta,
  decimalToMinor,
  minorToDecimal,
} from './recognition-math';

const may = (day: number, hour = 0, minute = 0): Date =>
  new Date(Date.UTC(2026, 4, day, hour, minute));

describe('computeRecognitionDelta — basic cases', () => {
  const periodStart = may(1, 0, 0);
  const periodEnd = may(31, 23, 59);
  const original = new Decimal('299.00');

  it('returns zero before the period starts', () => {
    const result = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal(0),
      servicePeriodStart: periodStart,
      servicePeriodEnd: periodEnd,
      asOf: new Date(Date.UTC(2026, 3, 30)), // April 30
      pausedDurationMs: 0,
    });
    expect(result.delta.eq(0)).toBe(true);
    expect(result.expectedCumulative.eq(0)).toBe(true);
    expect(result.isFinalRecognition).toBe(false);
    expect(result.hasRecognitionDue).toBe(false);
  });

  it('returns zero exactly at the period start', () => {
    const result = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal(0),
      servicePeriodStart: periodStart,
      servicePeriodEnd: periodEnd,
      asOf: periodStart,
      pausedDurationMs: 0,
    });
    expect(result.delta.eq(0)).toBe(true);
    expect(result.expectedCumulative.eq(0)).toBe(true);
  });

  it('recognises a partial amount mid-period', () => {
    // Mid-period: asOf at end of May 16 → ~half the way through.
    // Period: May 1 00:00:00 → May 31 23:59:00 → ~30 days 23h59m.
    // 15.999 / 30.999 ≈ 0.5161 → ~$154.32.
    const result = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal(0),
      servicePeriodStart: periodStart,
      servicePeriodEnd: periodEnd,
      asOf: may(16, 23, 59),
      pausedDurationMs: 0,
    });
    expect(result.delta.gt(0)).toBe(true);
    expect(result.delta.lt(original)).toBe(true);
    expect(result.delta.gte(new Decimal('140.00'))).toBe(true);
    expect(result.delta.lte(new Decimal('170.00'))).toBe(true);
    expect(result.isFinalRecognition).toBe(false);
    expect(result.hasRecognitionDue).toBe(true);
  });

  it('fully recognises on the final day', () => {
    const result = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal(0),
      servicePeriodStart: periodStart,
      servicePeriodEnd: periodEnd,
      asOf: periodEnd,
      pausedDurationMs: 0,
    });
    expect(result.delta.eq(original)).toBe(true);
    expect(result.expectedCumulative.eq(original)).toBe(true);
    expect(result.isFinalRecognition).toBe(true);
  });

  it('fully recognises after the period end (catch-up)', () => {
    const result = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal(0),
      servicePeriodStart: periodStart,
      servicePeriodEnd: periodEnd,
      asOf: new Date(Date.UTC(2026, 5, 15)), // June 15 — well past end
      pausedDurationMs: 0,
    });
    expect(result.delta.eq(original)).toBe(true);
    expect(result.isFinalRecognition).toBe(true);
  });
});

describe('computeRecognitionDelta — cumulative incremental sweeps', () => {
  const periodStart = may(1, 0, 0);
  // Use a clean 30-day period for easier mental math: 5/1 00:00 → 5/31 00:00.
  const periodEnd = new Date(Date.UTC(2026, 4, 31, 0, 0));
  const original = new Decimal('300.00');

  it('two consecutive same-day sweeps post nothing the second time', () => {
    const day10 = may(10, 12, 0);
    const first = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal(0),
      servicePeriodStart: periodStart,
      servicePeriodEnd: periodEnd,
      asOf: day10,
      pausedDurationMs: 0,
    });
    expect(first.delta.gt(0)).toBe(true);

    const second = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: first.expectedCumulative,
      servicePeriodStart: periodStart,
      servicePeriodEnd: periodEnd,
      asOf: day10,
      pausedDurationMs: 0,
    });
    expect(second.delta.eq(0)).toBe(true);
    expect(second.hasRecognitionDue).toBe(false);
  });

  it('cumulative across daily sweeps lands at the full original on final day', () => {
    let alreadyRecognized = new Decimal(0);
    // Sweep daily May 2 → May 31 inclusive.
    for (let day = 2; day <= 31; day++) {
      const { delta, expectedCumulative } = computeRecognitionDelta({
        originalAmount: original,
        alreadyRecognized,
        servicePeriodStart: periodStart,
        servicePeriodEnd: periodEnd,
        asOf: may(day, 0, 0),
        pausedDurationMs: 0,
      });
      alreadyRecognized = alreadyRecognized.plus(delta);
      expect(alreadyRecognized.eq(expectedCumulative)).toBe(true);
    }
    expect(alreadyRecognized.eq(original)).toBe(true);
  });

  it('handles a $299 / 31-day period with no rounding loss across the sweep', () => {
    const periodStart31 = may(1, 0, 0);
    const periodEnd31 = new Date(Date.UTC(2026, 5, 1, 0, 0)); // June 1 00:00 — 31 days exact
    const orig = new Decimal('299.00');

    let alreadyRecognized = new Decimal(0);
    for (let day = 2; day <= 31; day++) {
      const { delta, expectedCumulative } = computeRecognitionDelta({
        originalAmount: orig,
        alreadyRecognized,
        servicePeriodStart: periodStart31,
        servicePeriodEnd: periodEnd31,
        asOf: may(day, 0, 0),
        pausedDurationMs: 0,
      });
      alreadyRecognized = alreadyRecognized.plus(delta);
      expect(alreadyRecognized.eq(expectedCumulative)).toBe(true);
      expect(alreadyRecognized.lte(orig)).toBe(true);
    }
    // Final-day sweep (at periodEnd) zeroes out the remaining ~1¢
    // of rounding leftover.
    const final = computeRecognitionDelta({
      originalAmount: orig,
      alreadyRecognized,
      servicePeriodStart: periodStart31,
      servicePeriodEnd: periodEnd31,
      asOf: periodEnd31,
      pausedDurationMs: 0,
    });
    expect(final.isFinalRecognition).toBe(true);
    alreadyRecognized = alreadyRecognized.plus(final.delta);
    expect(alreadyRecognized.eq(orig)).toBe(true);
  });
});

describe('computeRecognitionDelta — edge cases', () => {
  const periodStart = may(1, 0, 0);
  const periodEnd = may(31, 23, 59);

  it('clamps negative delta to zero (out-of-order sweep)', () => {
    const result = computeRecognitionDelta({
      originalAmount: new Decimal('300.00'),
      // Already over-recognised (e.g. an admin manual adjustment ran).
      alreadyRecognized: new Decimal('200.00'),
      servicePeriodStart: periodStart,
      servicePeriodEnd: periodEnd,
      asOf: may(10), // expected cumulative is much less than 200
      pausedDurationMs: 0,
    });
    expect(result.delta.eq(0)).toBe(true);
    expect(result.hasRecognitionDue).toBe(false);
  });

  it('handles already-fully-recognised balance (no further delta)', () => {
    const original = new Decimal('100.00');
    const result = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: original,
      servicePeriodStart: periodStart,
      servicePeriodEnd: periodEnd,
      asOf: may(15),
      pausedDurationMs: 0,
    });
    expect(result.delta.eq(0)).toBe(true);
  });

  it('handles $0.01 original — degenerate but valid', () => {
    const result = computeRecognitionDelta({
      originalAmount: new Decimal('0.01'),
      alreadyRecognized: new Decimal(0),
      servicePeriodStart: periodStart,
      servicePeriodEnd: periodEnd,
      asOf: periodEnd,
      pausedDurationMs: 0,
    });
    expect(result.delta.eq(new Decimal('0.01'))).toBe(true);
    expect(result.isFinalRecognition).toBe(true);
  });

  it('handles the maximum decimal(12,2) envelope', () => {
    const original = new Decimal('99999999.99');
    const result = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal(0),
      servicePeriodStart: periodStart,
      servicePeriodEnd: periodEnd,
      asOf: periodEnd,
      pausedDurationMs: 0,
    });
    expect(result.delta.eq(original)).toBe(true);
  });

  it('exact-half rounding goes UP (HALF_UP)', () => {
    // Period covering 200 minutes, original = $1.00. Halfway through
    // (100 minutes in), expected = $0.50 exactly. Pre-halfway by half
    // a minute (99.5 min in) expected = $0.4975 → round to $0.50.
    const start = new Date(Date.UTC(2026, 4, 1, 0, 0, 0));
    const end = new Date(Date.UTC(2026, 4, 1, 3, 20, 0)); // 200 minutes
    const asOfHalf = new Date(Date.UTC(2026, 4, 1, 1, 39, 30)); // 99.5 min
    const result = computeRecognitionDelta({
      originalAmount: new Decimal('1.00'),
      alreadyRecognized: new Decimal(0),
      servicePeriodStart: start,
      servicePeriodEnd: end,
      asOf: asOfHalf,
      pausedDurationMs: 0,
    });
    // Expected raw = 1.00 * 99.5/200 = 0.4975 → HALF_UP rounds to 0.50.
    expect(result.expectedCumulative.eq(new Decimal('0.50'))).toBe(true);
  });
});

describe('minorToDecimal / decimalToMinor', () => {
  it('round-trips integer minor units exactly', () => {
    expect(decimalToMinor(minorToDecimal(0))).toBe(0);
    expect(decimalToMinor(minorToDecimal(1))).toBe(1);
    expect(decimalToMinor(minorToDecimal(99))).toBe(99);
    expect(decimalToMinor(minorToDecimal(100))).toBe(100);
    expect(decimalToMinor(minorToDecimal(29_900))).toBe(29_900);
    expect(decimalToMinor(minorToDecimal(99_999_999_99))).toBe(99_999_999_99);
  });
});

describe('asOfDailySuffix', () => {
  it('formats UTC date as YYYY-MM-DD', () => {
    expect(asOfDailySuffix(may(1, 0, 0))).toBe('2026-05-01');
    expect(asOfDailySuffix(may(31, 23, 59))).toBe('2026-05-31');
  });

  it('zero-pads single-digit month and day', () => {
    expect(asOfDailySuffix(new Date(Date.UTC(2026, 0, 5)))).toBe('2026-01-05');
  });

  it('uses UTC, not local time', () => {
    // 2026-05-31 23:00 UTC-04:00 = 2026-06-01 03:00 UTC. We format
    // the UTC date.
    const dt = new Date('2026-05-31T23:00:00-04:00');
    expect(asOfDailySuffix(dt)).toBe('2026-06-01');
  });
});

/**
 * TS-042-followup-3b2 — pause windows must not amortise.
 *
 * These are the tests that distinguish a real pause from a decorative
 * one. The fixture is the canonical case from the task: a 30-day
 * $300.00 period, paused on day 10 and resumed on day 20, whose end has
 * been extended to day 40 by `resumeRecognition`.
 */
describe('computeRecognitionDelta — paused windows (TS-042-followup-3b2)', () => {
  const DAY_MS = 86_400_000;
  const start = new Date(Date.UTC(2026, 5, 1)); // June 1
  const originalEnd = new Date(start.getTime() + 30 * DAY_MS); // July 1
  const extendedEnd = new Date(originalEnd.getTime() + 10 * DAY_MS); // July 11
  const tenDaysMs = 10 * DAY_MS;
  const original = new Decimal('300.00');
  const dayOf = (n: number): Date => new Date(start.getTime() + n * DAY_MS);

  it('recognises a tenth of the amount per three days before any pause', () => {
    const result = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal(0),
      servicePeriodStart: start,
      servicePeriodEnd: originalEnd,
      asOf: dayOf(10),
      pausedDurationMs: 0,
    });
    expect(result.expectedCumulative.toFixed(2)).toBe('100.00');
  });

  it('picks up EXACTLY where it stopped on the first post-resume sweep — the pause is not a catch-up', () => {
    // Day 10: $100.00 recognised, then paused. Day 20: resumed, period
    // end extended to day 40, ten paused days accumulated. The very
    // next sweep must post NOTHING — the family was served no days
    // between 10 and 20.
    const atResume = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal('100.00'),
      servicePeriodStart: start,
      servicePeriodEnd: extendedEnd,
      asOf: dayOf(20),
      pausedDurationMs: tenDaysMs,
    });
    expect(atResume.expectedCumulative.toFixed(2)).toBe('100.00');
    expect(atResume.delta.toFixed(2)).toBe('0.00');
    expect(atResume.hasRecognitionDue).toBe(false);
  });

  it('WITHOUT the paused-duration input the same sweep would post an unearned catch-up (the defect this guards)', () => {
    // Same row, same instant, but with the pause invisible to the math:
    // 20/40 of the period looks elapsed, so $50.00 of revenue is
    // recognised for ten days on which no service was delivered.
    // Extending the period end alone does NOT fix the pause.
    const naive = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal('100.00'),
      servicePeriodStart: start,
      servicePeriodEnd: extendedEnd,
      asOf: dayOf(20),
      pausedDurationMs: 0,
    });
    expect(naive.expectedCumulative.toFixed(2)).toBe('150.00');
    expect(naive.delta.toFixed(2)).toBe('50.00');
  });

  it('resumes accruing at the ORIGINAL daily rate after the pause', () => {
    // Day 25 = fifteen service days delivered out of thirty.
    const result = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal('100.00'),
      servicePeriodStart: start,
      servicePeriodEnd: extendedEnd,
      asOf: dayOf(25),
      pausedDurationMs: tenDaysMs,
    });
    expect(result.expectedCumulative.toFixed(2)).toBe('150.00');
    expect(result.delta.toFixed(2)).toBe('50.00');
  });

  it('fully recognises the original amount at the EXTENDED period end, never more', () => {
    const result = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal('150.00'),
      servicePeriodStart: start,
      servicePeriodEnd: extendedEnd,
      asOf: dayOf(40),
      pausedDurationMs: tenDaysMs,
    });
    expect(result.isFinalRecognition).toBe(true);
    expect(result.expectedCumulative.toFixed(2)).toBe('300.00');
    expect(result.delta.toFixed(2)).toBe('150.00');
  });

  it('does not reach full recognition at the ORIGINAL end date — the paused days moved out', () => {
    const result = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal('100.00'),
      servicePeriodStart: start,
      servicePeriodEnd: extendedEnd,
      asOf: originalEnd,
      pausedDurationMs: tenDaysMs,
    });
    expect(result.isFinalRecognition).toBe(false);
    expect(result.expectedCumulative.toFixed(2)).toBe('200.00');
  });

  it('accumulates across TWO pause cycles', () => {
    // Paused twice for ten days each: end is day 50, twenty days
    // suspended. Day 35 => fifteen service days => half the amount.
    const twiceExtendedEnd = new Date(originalEnd.getTime() + 20 * DAY_MS);
    const result = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal(0),
      servicePeriodStart: start,
      servicePeriodEnd: twiceExtendedEnd,
      asOf: dayOf(35),
      pausedDurationMs: 20 * DAY_MS,
    });
    expect(result.expectedCumulative.toFixed(2)).toBe('150.00');
  });

  it('returns zero when the whole elapsed window was suspended', () => {
    const result = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal(0),
      servicePeriodStart: start,
      servicePeriodEnd: extendedEnd,
      asOf: dayOf(10),
      pausedDurationMs: tenDaysMs,
    });
    expect(result.delta.eq(0)).toBe(true);
    expect(result.expectedCumulative.eq(0)).toBe(true);
    expect(result.hasRecognitionDue).toBe(false);
    expect(result.isFinalRecognition).toBe(false);
  });

  it('never divides by a non-positive denominator when paused time exceeds the period', () => {
    // Unreachable while resume extends the end in step, but a corrupt
    // row must degrade to "nothing due", not to NaN or Infinity.
    const result = computeRecognitionDelta({
      originalAmount: original,
      alreadyRecognized: new Decimal(0),
      servicePeriodStart: start,
      servicePeriodEnd: originalEnd,
      asOf: dayOf(20),
      pausedDurationMs: 40 * DAY_MS,
    });
    expect(result.delta.eq(0)).toBe(true);
    expect(result.expectedCumulative.isFinite()).toBe(true);
    expect(result.hasRecognitionDue).toBe(false);
  });
});
