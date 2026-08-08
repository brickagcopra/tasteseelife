import { describe, expect, it } from 'vitest';

import { MAX_OCCURRENCES, expandRrule, parseRrule } from './rrule-expander';

/**
 * Tests for the Phase-1 RRULE expander (TS-061; PRD §6.3).
 *
 * The expander is pure TS — every test calls `parseRrule` then
 * `expandRrule` against a known anchor. The assertions cover:
 *
 *   - happy paths (weekly, biweekly, monthly with COUNT or UNTIL)
 *   - structural rejections (malformed, unsupported clauses, bad
 *     INTERVAL, both COUNT + UNTIL)
 *   - termination correctness (COUNT, UNTIL, the global cap)
 *   - the monthly_day_overflow skip semantics
 *   - DST-immune UTC walking
 */

const T = (iso: string): Date => new Date(iso);

describe('parseRrule', () => {
  it('parses FREQ=WEEKLY;COUNT=4 (canonical weekly)', () => {
    const r = parseRrule('FREQ=WEEKLY;COUNT=4');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.freq).toBe('WEEKLY');
      expect(r.value.interval).toBe(1);
      expect(r.value.count).toBe(4);
      expect(r.value.until).toBeNull();
    }
  });

  it('parses FREQ=WEEKLY;INTERVAL=2;COUNT=12 (biweekly, 12 occurrences)', () => {
    const r = parseRrule('FREQ=WEEKLY;INTERVAL=2;COUNT=12');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.freq).toBe('WEEKLY');
      expect(r.value.interval).toBe(2);
      expect(r.value.count).toBe(12);
    }
  });

  it('parses FREQ=MONTHLY;COUNT=6', () => {
    const r = parseRrule('FREQ=MONTHLY;COUNT=6');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.freq).toBe('MONTHLY');
      expect(r.value.interval).toBe(1);
      expect(r.value.count).toBe(6);
    }
  });

  it('parses UNTIL clauses in RFC 5545 basic-format UTC', () => {
    const r = parseRrule('FREQ=WEEKLY;UNTIL=20260801T180000Z');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.until?.toISOString()).toBe('2026-08-01T18:00:00.000Z');
      expect(r.value.count).toBeNull();
    }
  });

  it('strips the optional RRULE: prefix and trims whitespace', () => {
    const r = parseRrule('  RRULE:FREQ=WEEKLY;COUNT=3  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.freq).toBe('WEEKLY');
  });

  it('is case-insensitive on clause names', () => {
    const r = parseRrule('freq=WEEKLY;count=2');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.count).toBe(2);
  });

  it('rejects empty input', () => {
    const r = parseRrule('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('malformed_rrule');
  });

  it('rejects missing FREQ', () => {
    const r = parseRrule('COUNT=3');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('malformed_rrule');
  });

  it('rejects unsupported FREQ values', () => {
    const r = parseRrule('FREQ=DAILY;COUNT=5');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.reason).toBe('unsupported_frequency');
      if (r.error.reason === 'unsupported_frequency') {
        expect(r.error.freq).toBe('DAILY');
      }
    }
  });

  it('rejects unsupported clauses (BYDAY, WKST, BYMONTHDAY)', () => {
    for (const clause of ['BYDAY=MO', 'WKST=SU', 'BYMONTHDAY=15', 'BYSETPOS=1']) {
      const r = parseRrule(`FREQ=WEEKLY;${clause};COUNT=3`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe('unsupported_clause');
    }
  });

  it('rejects INTERVAL=0 or non-integer', () => {
    for (const v of ['INTERVAL=0', 'INTERVAL=-1', 'INTERVAL=1.5', 'INTERVAL=abc']) {
      const r = parseRrule(`FREQ=WEEKLY;${v};COUNT=3`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe('invalid_interval');
    }
  });

  it('rejects WEEKLY INTERVAL > 4', () => {
    const r = parseRrule('FREQ=WEEKLY;INTERVAL=5;COUNT=3');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid_interval');
  });

  it('rejects MONTHLY INTERVAL > 12', () => {
    const r = parseRrule('FREQ=MONTHLY;INTERVAL=13;COUNT=3');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid_interval');
  });

  it('rejects COUNT > MAX_OCCURRENCES', () => {
    const r = parseRrule(`FREQ=WEEKLY;COUNT=${MAX_OCCURRENCES + 1}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid_count');
  });

  it('rejects malformed UNTIL', () => {
    for (const v of [
      'UNTIL=2026-08-01',
      'UNTIL=20260801',
      'UNTIL=20260801T180000', // missing Z
      'UNTIL=20261301T000000Z', // bad month
      'UNTIL=20260230T000000Z', // bad day for Feb
      'UNTIL=20260801T250000Z', // bad hour
    ]) {
      const r = parseRrule(`FREQ=WEEKLY;${v}`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe('invalid_until');
    }
  });

  it('rejects RRULE with both COUNT and UNTIL', () => {
    const r = parseRrule('FREQ=WEEKLY;COUNT=4;UNTIL=20260801T180000Z');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('unsupported_termination');
  });

  it('rejects RRULE with neither COUNT nor UNTIL', () => {
    const r = parseRrule('FREQ=WEEKLY;INTERVAL=1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('unsupported_termination');
  });

  it('rejects clauses not in NAME=VALUE form', () => {
    const r = parseRrule('FREQ=WEEKLY;COUNT;INTERVAL=1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('malformed_rrule');
  });
});

describe('expandRrule — WEEKLY', () => {
  it('emits four weekly occurrences starting from dtstart', () => {
    const parsed = parseRrule('FREQ=WEEKLY;COUNT=4');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const start = T('2026-05-14T18:00:00.000Z'); // Thursday
    const exp = expandRrule(parsed.value, start);
    expect(exp.occurrences).toHaveLength(4);
    expect(exp.occurrences[0]?.toISOString()).toBe('2026-05-14T18:00:00.000Z');
    expect(exp.occurrences[1]?.toISOString()).toBe('2026-05-21T18:00:00.000Z');
    expect(exp.occurrences[2]?.toISOString()).toBe('2026-05-28T18:00:00.000Z');
    expect(exp.occurrences[3]?.toISOString()).toBe('2026-06-04T18:00:00.000Z');
    expect(exp.warnings).toHaveLength(0);
  });

  it('emits biweekly occurrences with INTERVAL=2', () => {
    const parsed = parseRrule('FREQ=WEEKLY;INTERVAL=2;COUNT=3');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const start = T('2026-05-14T18:00:00.000Z');
    const exp = expandRrule(parsed.value, start);
    expect(exp.occurrences).toHaveLength(3);
    expect(exp.occurrences[0]?.toISOString()).toBe('2026-05-14T18:00:00.000Z');
    expect(exp.occurrences[1]?.toISOString()).toBe('2026-05-28T18:00:00.000Z');
    expect(exp.occurrences[2]?.toISOString()).toBe('2026-06-11T18:00:00.000Z');
  });

  it('terminates by UNTIL', () => {
    const parsed = parseRrule('FREQ=WEEKLY;UNTIL=20260605T000000Z');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const start = T('2026-05-14T18:00:00.000Z');
    const exp = expandRrule(parsed.value, start);
    // May 14, May 21, May 28 fit; June 4 18:00 also fits (<= June 5 00:00? yes, 06-04T18:00 < 06-05T00:00).
    // June 11 18:00 exceeds UNTIL.
    expect(exp.occurrences).toHaveLength(4);
    expect(exp.occurrences.at(-1)?.toISOString()).toBe('2026-06-04T18:00:00.000Z');
  });

  it('is DST-immune (UTC arithmetic)', () => {
    // Anchor before a US DST transition (Mar 8 2026 02:00 local in
    // ET); UTC offset shifts. Our expander stores UTC instants so
    // every Thursday lands on the same UTC clock time.
    const parsed = parseRrule('FREQ=WEEKLY;COUNT=3');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const start = T('2026-03-05T18:00:00.000Z'); // Thursday before DST
    const exp = expandRrule(parsed.value, start);
    expect(exp.occurrences).toHaveLength(3);
    // All three should be at UTC 18:00 — DST transition does NOT
    // shift the UTC clock.
    for (const at of exp.occurrences) {
      expect(at.getUTCHours()).toBe(18);
      expect(at.getUTCMinutes()).toBe(0);
    }
  });

  it('caps at MAX_OCCURRENCES for an open-ended UNTIL', () => {
    // UNTIL set far in the future so the expander would otherwise
    // emit > 52 occurrences.
    const parsed = parseRrule('FREQ=WEEKLY;UNTIL=20280101T000000Z');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const start = T('2026-05-14T18:00:00.000Z');
    const exp = expandRrule(parsed.value, start);
    expect(exp.occurrences.length).toBeLessThanOrEqual(MAX_OCCURRENCES);
    expect(exp.occurrences).toHaveLength(MAX_OCCURRENCES);
    expect(exp.warnings).toContainEqual({ kind: 'occurrence_cap_reached' });
  });
});

describe('expandRrule — MONTHLY', () => {
  it('emits six monthly occurrences preserving day-of-month', () => {
    const parsed = parseRrule('FREQ=MONTHLY;COUNT=6');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const start = T('2026-05-14T18:00:00.000Z');
    const exp = expandRrule(parsed.value, start);
    expect(exp.occurrences).toHaveLength(6);
    expect(exp.occurrences.map((d) => d.toISOString())).toEqual([
      '2026-05-14T18:00:00.000Z',
      '2026-06-14T18:00:00.000Z',
      '2026-07-14T18:00:00.000Z',
      '2026-08-14T18:00:00.000Z',
      '2026-09-14T18:00:00.000Z',
      '2026-10-14T18:00:00.000Z',
    ]);
    expect(exp.warnings).toHaveLength(0);
  });

  it('skips months that are too short for the anchor day (Jan 31 → Feb skipped)', () => {
    const parsed = parseRrule('FREQ=MONTHLY;COUNT=3');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const start = T('2026-01-31T18:00:00.000Z');
    const exp = expandRrule(parsed.value, start);
    expect(exp.occurrences).toHaveLength(3);
    expect(exp.occurrences.map((d) => d.toISOString())).toEqual([
      '2026-01-31T18:00:00.000Z',
      // Feb 2026 has 28 days — skipped.
      '2026-03-31T18:00:00.000Z',
      // April has 30 — skipped.
      '2026-05-31T18:00:00.000Z',
    ]);
    expect(
      exp.warnings.filter((w) => w.kind === 'monthly_day_overflow').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('handles leap year February correctly', () => {
    const parsed = parseRrule('FREQ=MONTHLY;COUNT=2');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 2028 is a leap year — Feb 29 exists. Anchor on Feb 29.
    const start = T('2028-02-29T12:00:00.000Z');
    const exp = expandRrule(parsed.value, start);
    expect(exp.occurrences[0]?.toISOString()).toBe('2028-02-29T12:00:00.000Z');
    // Mar has 31 days — Mar 29 exists.
    expect(exp.occurrences[1]?.toISOString()).toBe('2028-03-29T12:00:00.000Z');
  });

  it('honours INTERVAL=3 for quarterly visits', () => {
    const parsed = parseRrule('FREQ=MONTHLY;INTERVAL=3;COUNT=4');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const start = T('2026-01-15T18:00:00.000Z');
    const exp = expandRrule(parsed.value, start);
    expect(exp.occurrences.map((d) => d.toISOString())).toEqual([
      '2026-01-15T18:00:00.000Z',
      '2026-04-15T18:00:00.000Z',
      '2026-07-15T18:00:00.000Z',
      '2026-10-15T18:00:00.000Z',
    ]);
  });

  it('terminates monthly schedules by UNTIL', () => {
    const parsed = parseRrule('FREQ=MONTHLY;UNTIL=20260901T000000Z');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const start = T('2026-05-14T18:00:00.000Z');
    const exp = expandRrule(parsed.value, start);
    // May 14, Jun 14, Jul 14, Aug 14 fit; Sep 14 exceeds UNTIL Sep 01.
    expect(exp.occurrences).toHaveLength(4);
    expect(exp.occurrences.at(-1)?.toISOString()).toBe('2026-08-14T18:00:00.000Z');
  });
});

describe('expandRrule — edge cases', () => {
  it('emits zero occurrences when dtstart > UNTIL', () => {
    const parsed = parseRrule('FREQ=WEEKLY;UNTIL=20260101T000000Z');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const start = T('2026-05-14T18:00:00.000Z');
    const exp = expandRrule(parsed.value, start);
    expect(exp.occurrences).toHaveLength(0);
  });

  it('always emits dtstart as occurrence[0]', () => {
    const parsed = parseRrule('FREQ=WEEKLY;COUNT=1');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const start = T('2026-05-14T18:00:00.000Z');
    const exp = expandRrule(parsed.value, start);
    expect(exp.occurrences).toHaveLength(1);
    expect(exp.occurrences[0]?.toISOString()).toBe(start.toISOString());
  });
});
