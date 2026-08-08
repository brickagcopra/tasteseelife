import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';

import {
  AVG_DAYS_PER_MONTH,
  asDecimal,
  computeArpu,
  decimalToMinor,
  decomposeMovement,
  normalizeMonthlyMrr,
  PPM_SCALE,
  ratioToPpm,
  toUtcDateOnly,
  utcDateKey,
} from './saas-metrics-math';

function map(entries: ReadonlyArray<readonly [string, string]>): Map<string, Decimal> {
  return new Map(entries.map(([k, v]) => [k, new Decimal(v)]));
}

describe('normalizeMonthlyMrr', () => {
  it('resolves a ~monthly period to ≈ its face value', () => {
    // 30-day period, $29.00 face → ~$29.42 monthly-normalised
    // (29 × 30.4375 / 30).
    const mrr = normalizeMonthlyMrr({
      originalAmount: new Decimal('29.00'),
      servicePeriodStart: new Date('2026-05-01T00:00:00Z'),
      servicePeriodEnd: new Date('2026-05-31T00:00:00Z'),
      pausedDurationSeconds: 0,
    });
    expect(mrr.toFixed(2)).toBe('29.42');
  });

  it('resolves an annual period to ≈ annual ÷ 12', () => {
    // 365-day period, $1200.00 annual → 1200 × 30.4375 / 365 = $100.07
    const mrr = normalizeMonthlyMrr({
      originalAmount: new Decimal('1200.00'),
      servicePeriodStart: new Date('2026-01-01T00:00:00Z'),
      servicePeriodEnd: new Date('2027-01-01T00:00:00Z'),
      pausedDurationSeconds: 0,
    });
    expect(mrr.toFixed(2)).toBe('100.07');
  });

  it('rounds half-up to the cent', () => {
    const mrr = normalizeMonthlyMrr({
      originalAmount: new Decimal('100.00'),
      servicePeriodStart: new Date('2026-05-01T00:00:00Z'),
      servicePeriodEnd: new Date('2026-06-01T00:00:00Z'),
      pausedDurationSeconds: 0,
    });
    // 100 × 30.4375 / 31 = 98.18548... → 98.19
    expect(mrr.toFixed(2)).toBe('98.19');
  });

  it('nets suspended time off the period so a resumed subscription is not read as a contraction (TS-042-followup-3b2)', () => {
    // The same 30-day $29.00 balance after a ten-day pause: resume
    // extended `servicePeriodEnd` to 40 days. Dividing the face value
    // across all 40 calendar days would report $22.07 and book a $7.35
    // contraction that never happened.
    const resumed = normalizeMonthlyMrr({
      originalAmount: new Decimal('29.00'),
      servicePeriodStart: new Date('2026-05-01T00:00:00Z'),
      servicePeriodEnd: new Date('2026-06-10T00:00:00Z'),
      pausedDurationSeconds: 10 * 86_400,
    });
    expect(resumed.toFixed(2)).toBe('29.42');

    const uncorrected = normalizeMonthlyMrr({
      originalAmount: new Decimal('29.00'),
      servicePeriodStart: new Date('2026-05-01T00:00:00Z'),
      servicePeriodEnd: new Date('2026-06-10T00:00:00Z'),
      pausedDurationSeconds: 0,
    });
    expect(uncorrected.toFixed(2)).toBe('22.07');
  });

  it('returns 0 when suspended time swallows the whole period rather than dividing by a non-positive span', () => {
    expect(
      normalizeMonthlyMrr({
        originalAmount: new Decimal('29.00'),
        servicePeriodStart: new Date('2026-05-01T00:00:00Z'),
        servicePeriodEnd: new Date('2026-05-31T00:00:00Z'),
        pausedDurationSeconds: 40 * 86_400,
      }).toNumber(),
    ).toBe(0);
  });

  it('returns 0 for an inverted or zero-length period', () => {
    expect(
      normalizeMonthlyMrr({
        originalAmount: new Decimal('29.00'),
        servicePeriodStart: new Date('2026-05-31T00:00:00Z'),
        servicePeriodEnd: new Date('2026-05-01T00:00:00Z'),
        pausedDurationSeconds: 0,
      }).toNumber(),
    ).toBe(0);
    expect(
      normalizeMonthlyMrr({
        originalAmount: new Decimal('29.00'),
        servicePeriodStart: new Date('2026-05-01T00:00:00Z'),
        servicePeriodEnd: new Date('2026-05-01T00:00:00Z'),
        pausedDurationSeconds: 0,
      }).toNumber(),
    ).toBe(0);
  });

  it('exposes the average-days-per-month constant', () => {
    expect(AVG_DAYS_PER_MONTH.toString()).toBe('30.4375');
  });
});

describe('computeArpu', () => {
  it('divides MRR by the active subscription count', () => {
    expect(computeArpu(new Decimal('1500.00'), 100).toFixed(2)).toBe('15.00');
  });

  it('rounds half-up to the cent', () => {
    // 1000 / 3 = 333.333... → 333.33
    expect(computeArpu(new Decimal('1000.00'), 3).toFixed(2)).toBe('333.33');
  });

  it('returns 0 when there are no active subscriptions', () => {
    expect(computeArpu(new Decimal('0'), 0).toNumber()).toBe(0);
    expect(computeArpu(new Decimal('500.00'), 0).toNumber()).toBe(0);
  });
});

describe('decomposeMovement', () => {
  it('treats every subscription as new when there is no prior baseline', () => {
    const result = decomposeMovement({
      current: map([
        ['s1', '29.42'],
        ['s2', '100.07'],
      ]),
      prior: null,
    });
    expect(result.newMrr.toFixed(2)).toBe('129.49');
    expect(result.expansionMrr.toNumber()).toBe(0);
    expect(result.contractionMrr.toNumber()).toBe(0);
    expect(result.churnedMrr.toNumber()).toBe(0);
    expect(result.churnedSubscriptions).toBe(0);
    expect(result.netNewMrr.toFixed(2)).toBe('129.49');
    expect(result.priorMrr.toNumber()).toBe(0);
    expect(result.netRevenueRetention).toBeNull();
    expect(result.grossRevenueRetention).toBeNull();
  });

  it('classifies new / expansion / contraction / churn against a prior baseline', () => {
    const result = decomposeMovement({
      current: map([
        ['keep', '100.00'], // unchanged
        ['grow', '150.00'], // expansion +50
        ['shrink', '60.00'], // contraction -40
        ['fresh', '30.00'], // new
      ]),
      prior: map([
        ['keep', '100.00'],
        ['grow', '100.00'],
        ['shrink', '100.00'],
        ['gone', '80.00'], // churned
      ]),
    });
    expect(result.newMrr.toFixed(2)).toBe('30.00');
    expect(result.expansionMrr.toFixed(2)).toBe('50.00');
    expect(result.contractionMrr.toFixed(2)).toBe('40.00');
    expect(result.churnedMrr.toFixed(2)).toBe('80.00');
    expect(result.churnedSubscriptions).toBe(1);
    expect(result.priorMrr.toFixed(2)).toBe('380.00');
    // net new = 30 + 50 − 40 − 80 = −40
    expect(result.netNewMrr.toFixed(2)).toBe('-40.00');
  });

  it('computes NRR and GRR against the prior baseline', () => {
    const result = decomposeMovement({
      current: map([
        ['keep', '100.00'],
        ['grow', '150.00'],
        ['shrink', '60.00'],
      ]),
      prior: map([
        ['keep', '100.00'],
        ['grow', '100.00'],
        ['shrink', '100.00'],
        ['gone', '100.00'],
      ]),
    });
    // prior = 400; expansion 50; contraction 40; churned 100
    // NRR = (400 + 50 − 40 − 100) / 400 = 310/400 = 0.775
    // GRR = (400 − 40 − 100) / 400 = 260/400 = 0.65
    expect(result.netRevenueRetention?.toFixed(6)).toBe('0.775000');
    expect(result.grossRevenueRetention?.toFixed(6)).toBe('0.650000');
  });

  it('yields NRR > 1 when expansion outweighs contraction + churn', () => {
    const result = decomposeMovement({
      current: map([['grow', '200.00']]),
      prior: map([['grow', '100.00']]),
    });
    // NRR = (100 + 100 − 0 − 0) / 100 = 2.0; GRR = 100/100 = 1.0
    expect(result.netRevenueRetention?.toFixed(6)).toBe('2.000000');
    expect(result.grossRevenueRetention?.toFixed(6)).toBe('1.000000');
  });

  it('returns null retention when the prior baseline MRR is zero', () => {
    const result = decomposeMovement({
      current: map([['s1', '10.00']]),
      prior: new Map<string, Decimal>(), // prior exists but is empty
    });
    expect(result.priorMrr.toNumber()).toBe(0);
    expect(result.netRevenueRetention).toBeNull();
    expect(result.grossRevenueRetention).toBeNull();
    expect(result.newMrr.toFixed(2)).toBe('10.00');
  });
});

describe('ratioToPpm', () => {
  it('converts a ratio to integer parts-per-million', () => {
    expect(ratioToPpm(new Decimal('1.0'))).toBe(1_000_000);
    expect(ratioToPpm(new Decimal('0.775'))).toBe(775_000);
    expect(ratioToPpm(new Decimal('1.027100'))).toBe(1_027_100);
  });

  it('passes null through', () => {
    expect(ratioToPpm(null)).toBeNull();
  });

  it('exposes the ppm scale constant', () => {
    expect(PPM_SCALE).toBe(1_000_000);
  });
});

describe('decimalToMinor', () => {
  it('converts dollars to integer cents', () => {
    expect(decimalToMinor(new Decimal('29.42'))).toBe(2942);
    expect(decimalToMinor(new Decimal('-40.00'))).toBe(-4000);
    expect(decimalToMinor(new Decimal('0'))).toBe(0);
  });
});

describe('asDecimal', () => {
  it('passes a Decimal through unchanged', () => {
    const d = new Decimal('12.34');
    expect(asDecimal(d)).toBe(d);
  });

  it('coerces a Prisma-style toString()-able object', () => {
    expect(asDecimal({ toString: () => '56.78' }).toFixed(2)).toBe('56.78');
  });

  it('coerces strings and numbers', () => {
    expect(asDecimal('9.99').toFixed(2)).toBe('9.99');
    expect(asDecimal(10).toFixed(2)).toBe('10.00');
  });

  it('throws on an uncoercible value', () => {
    expect(() => asDecimal(null)).toThrow(/unexpected non-Decimal/);
    expect(() => asDecimal(undefined)).toThrow(/unexpected non-Decimal/);
  });
});

describe('toUtcDateOnly / utcDateKey', () => {
  it('truncates a timestamp to midnight UTC', () => {
    const truncated = toUtcDateOnly(new Date('2026-05-28T14:37:09.123Z'));
    expect(truncated.toISOString()).toBe('2026-05-28T00:00:00.000Z');
  });

  it('formats the UTC calendar-date key', () => {
    expect(utcDateKey(new Date('2026-05-28T14:37:09.123Z'))).toBe('2026-05-28');
    expect(utcDateKey(new Date('2026-01-05T23:59:59Z'))).toBe('2026-01-05');
  });
});
