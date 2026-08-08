import { describe, expect, it } from 'vitest';

import {
  computeCommissionMinor,
  decimalStringToMinor,
  minorToDecimalString,
  ratioFromBps,
  ratioStringToBps,
} from './money';

/**
 * Unit suite for the shared booking-money helpers (TS-063-followup-8).
 * The five pure functions were previously duplicated across five files;
 * consolidating exercise here defuses the drift risk.
 */
describe('decimalStringToMinor', () => {
  it('parses a canonical Decimal(12,2) string into integer minor units', () => {
    expect(decimalStringToMinor('150.00')).toBe(15000);
    expect(decimalStringToMinor('99.05')).toBe(9905);
    expect(decimalStringToMinor('0.00')).toBe(0);
  });

  it('preserves the sign of a negative amount', () => {
    expect(decimalStringToMinor('-99.05')).toBe(-9905);
    expect(decimalStringToMinor('-0.01')).toBe(-1);
  });

  it('handles a missing fractional segment by padding to "00"', () => {
    expect(decimalStringToMinor('42')).toBe(4200);
    expect(decimalStringToMinor('-42')).toBe(-4200);
  });

  it('truncates more than two fractional digits to two', () => {
    // Postgres Decimal(12,2) never emits more than two fractional
    // digits — but the helper is defensive against a malformed input.
    expect(decimalStringToMinor('1.234')).toBe(123);
  });

  it('pads a single fractional digit to two', () => {
    expect(decimalStringToMinor('1.5')).toBe(150);
  });

  it('throws on a non-numeric input', () => {
    expect(() => decimalStringToMinor('abc')).toThrow(
      "decimalStringToMinor: invalid decimal 'abc'",
    );
    expect(() => decimalStringToMinor('12.ab')).toThrow(
      "decimalStringToMinor: invalid decimal '12.ab'",
    );
  });

  it('round-trips with minorToDecimalString', () => {
    // 0 is excluded from the negate branch — `Math.abs(-0) === 0` so
    // `minorToDecimalString(-0)` returns "0.00", and the round-trip
    // produces +0; `expect(...).toBe(-0)` would fail under `Object.is`
    // semantics. The +0 outcome is the right Phase-1 contract: there
    // is no negative-zero money amount.
    for (const minor of [0, 1, 99, 100, 9905, 15000, 1234567]) {
      expect(decimalStringToMinor(minorToDecimalString(minor))).toBe(minor);
    }
    for (const minor of [1, 99, 100, 9905, 15000, 1234567]) {
      expect(decimalStringToMinor(minorToDecimalString(-minor))).toBe(-minor);
    }
  });
});

describe('minorToDecimalString', () => {
  it('formats positive minor units with a two-digit fractional segment', () => {
    expect(minorToDecimalString(15000)).toBe('150.00');
    expect(minorToDecimalString(9905)).toBe('99.05');
    expect(minorToDecimalString(0)).toBe('0.00');
    expect(minorToDecimalString(1)).toBe('0.01');
    expect(minorToDecimalString(99)).toBe('0.99');
  });

  it('preserves the sign on a negative amount', () => {
    expect(minorToDecimalString(-1)).toBe('-0.01');
    expect(minorToDecimalString(-9905)).toBe('-99.05');
  });

  it('zero-pads single-digit cents', () => {
    expect(minorToDecimalString(100)).toBe('1.00');
    expect(minorToDecimalString(105)).toBe('1.05');
    expect(minorToDecimalString(110)).toBe('1.10');
  });
});

describe('ratioStringToBps', () => {
  it('parses a canonical Decimal(5,4) string into integer basis points', () => {
    expect(ratioStringToBps('0.3000')).toBe(3000);
    expect(ratioStringToBps('0.1000')).toBe(1000);
    expect(ratioStringToBps('0.2000')).toBe(2000);
    expect(ratioStringToBps('1.0000')).toBe(10_000);
    expect(ratioStringToBps('0.0000')).toBe(0);
  });

  it('handles a missing fractional segment by padding to "0000"', () => {
    expect(ratioStringToBps('1')).toBe(10_000);
    expect(ratioStringToBps('0')).toBe(0);
  });

  it('truncates more than four fractional digits to four', () => {
    expect(ratioStringToBps('0.30005')).toBe(3000);
  });

  it('pads fewer than four fractional digits to four', () => {
    expect(ratioStringToBps('0.3')).toBe(3000);
    expect(ratioStringToBps('0.30')).toBe(3000);
    expect(ratioStringToBps('0.300')).toBe(3000);
  });

  it('throws on a non-numeric input', () => {
    expect(() => ratioStringToBps('abc')).toThrow("ratioStringToBps: invalid ratio 'abc'");
    expect(() => ratioStringToBps('0.abc')).toThrow("ratioStringToBps: invalid ratio '0.abc'");
  });

  it('round-trips with ratioFromBps', () => {
    for (const bps of [0, 1, 9_999, 10_000, 3000, 2000, 1000]) {
      expect(ratioStringToBps(ratioFromBps(bps))).toBe(bps);
    }
  });
});

describe('ratioFromBps', () => {
  it('formats basis points as a Decimal(5,4) string', () => {
    expect(ratioFromBps(3000)).toBe('0.3000');
    expect(ratioFromBps(2000)).toBe('0.2000');
    expect(ratioFromBps(1000)).toBe('0.1000');
    expect(ratioFromBps(10_000)).toBe('1.0000');
    expect(ratioFromBps(0)).toBe('0.0000');
  });

  it('zero-pads sub-1000 bps to four fractional digits', () => {
    expect(ratioFromBps(1)).toBe('0.0001');
    expect(ratioFromBps(10)).toBe('0.0010');
    expect(ratioFromBps(100)).toBe('0.0100');
  });
});

describe('computeCommissionMinor', () => {
  it('multiplies base × rate and rounds to nearest cent', () => {
    // $150 × 20% → $30
    expect(computeCommissionMinor(15000, 2000)).toBe(3000);
    // $150 × 30% → $45
    expect(computeCommissionMinor(15000, 3000)).toBe(4500);
    // $150 × 10% → $15
    expect(computeCommissionMinor(15000, 1000)).toBe(1500);
  });

  it('rounds half-up at the cent boundary', () => {
    // 100 × 1234 / 10000 = 12.34 → 12
    expect(computeCommissionMinor(100, 1234)).toBe(12);
    // 100 × 1250 / 10000 = 12.5 → 13 (Math.round rounds 0.5 up to nearest integer)
    expect(computeCommissionMinor(100, 1250)).toBe(13);
    // 100 × 1235 / 10000 = 12.35 → 12
    expect(computeCommissionMinor(100, 1235)).toBe(12);
    // 100 × 1245 / 10000 = 12.45 → 12
    expect(computeCommissionMinor(100, 1245)).toBe(12);
  });

  it('returns zero on a zero base or zero rate', () => {
    expect(computeCommissionMinor(0, 3000)).toBe(0);
    expect(computeCommissionMinor(15000, 0)).toBe(0);
    expect(computeCommissionMinor(0, 0)).toBe(0);
  });

  it('handles the maximum rate (10000 bps == 100%) as identity', () => {
    expect(computeCommissionMinor(15000, 10_000)).toBe(15000);
    expect(computeCommissionMinor(1, 10_000)).toBe(1);
  });
});
