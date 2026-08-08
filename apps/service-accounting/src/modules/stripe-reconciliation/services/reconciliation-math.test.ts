import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';

import {
  aggregateToDecimal,
  dayWindowUtc,
  decimalToMinor,
  defaultReconciliationDayKey,
  minorToDecimal,
  utcDayKey,
} from './reconciliation-math';

describe('utcDayKey', () => {
  it('formats a Date as its UTC calendar date', () => {
    expect(utcDayKey(new Date('2026-05-28T23:59:59.000Z'))).toBe('2026-05-28');
    expect(utcDayKey(new Date('2026-01-05T00:00:00.000Z'))).toBe('2026-01-05');
  });

  it('uses UTC, not local time', () => {
    // 2026-05-29T00:30Z is still the 29th in UTC regardless of host TZ.
    expect(utcDayKey(new Date('2026-05-29T00:30:00.000Z'))).toBe('2026-05-29');
  });
});

describe('defaultReconciliationDayKey', () => {
  it('returns the day before `now` (the most-recently-completed UTC day)', () => {
    expect(defaultReconciliationDayKey(new Date('2026-05-29T03:00:00.000Z'))).toBe('2026-05-28');
  });

  it('rolls over a month boundary', () => {
    expect(defaultReconciliationDayKey(new Date('2026-06-01T02:00:00.000Z'))).toBe('2026-05-31');
  });
});

describe('dayWindowUtc', () => {
  it('returns the [start, end) midnight-to-midnight UTC window', () => {
    const { start, end } = dayWindowUtc('2026-05-28');
    expect(start.toISOString()).toBe('2026-05-28T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-29T00:00:00.000Z');
  });

  it('throws on an invalid day key', () => {
    expect(() => dayWindowUtc('not-a-date')).toThrow();
  });
});

describe('decimalToMinor / minorToDecimal', () => {
  it('round-trips dollar values through minor units', () => {
    expect(decimalToMinor(new Decimal('150.00'))).toBe(15_000);
    expect(decimalToMinor(new Decimal('-75.25'))).toBe(-7_525);
    expect(minorToDecimal(15_000).toFixed(2)).toBe('150.00');
    expect(minorToDecimal(-7_525).toFixed(2)).toBe('-75.25');
  });

  it('rounds at the cent', () => {
    expect(decimalToMinor(new Decimal('0.005'))).toBe(1);
  });
});

describe('aggregateToDecimal', () => {
  it('coerces null/undefined to zero', () => {
    expect(aggregateToDecimal(null).toFixed(2)).toBe('0.00');
    expect(aggregateToDecimal(undefined).toFixed(2)).toBe('0.00');
  });

  it('coerces a Decimal-shaped object via toString', () => {
    expect(aggregateToDecimal({ toString: () => '42.50' }).toFixed(2)).toBe('42.50');
  });

  it('passes a Decimal instance through', () => {
    const d = new Decimal('99.99');
    expect(aggregateToDecimal(d)).toBe(d);
  });
});
