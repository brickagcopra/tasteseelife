import { describe, expect, it } from 'vitest';

import {
  canTransition,
  isUsJurisdictionCode,
  MANDATED_REPORTER_CASE_STATUSES,
  MANDATED_REPORTER_STATUS_TRANSITIONS,
  MANDATED_REPORTER_TERMINAL_STATUS,
  US_JURISDICTION_CODES,
  type MandatedReporterCaseStatus,
} from './mandated-reporter-enums';

/**
 * The transition matrix is the workflow. These tests pin it exhaustively
 * (every from × to pair) rather than sampling, following the
 * `BOOKING_STATUS_TRANSITIONS` precedent — a silently-widened matrix on this
 * surface would mean an elder-abuse case reaching signoff without ever being
 * assessed.
 */
describe('MANDATED_REPORTER_STATUS_TRANSITIONS', () => {
  it('mirrors the Prisma enum key set', () => {
    expect([...MANDATED_REPORTER_CASE_STATUSES].sort()).toEqual([
      'filed',
      'filing_prep',
      'not_reportable',
      'screening',
      'signed_off',
    ]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(MANDATED_REPORTER_STATUS_TRANSITIONS)).toBe(true);
  });

  const EXPECTED: Record<MandatedReporterCaseStatus, MandatedReporterCaseStatus[]> = {
    screening: ['filing_prep', 'not_reportable'],
    filing_prep: ['filed', 'not_reportable'],
    filed: ['signed_off'],
    not_reportable: ['filing_prep', 'signed_off'],
    signed_off: [],
  };

  it.each(MANDATED_REPORTER_CASE_STATUSES)('pins every target reachable from %s', (from) => {
    for (const to of MANDATED_REPORTER_CASE_STATUSES) {
      expect(canTransition(from, to)).toBe(EXPECTED[from].includes(to));
    }
  });

  it('makes signed_off the only terminal state', () => {
    const terminal = MANDATED_REPORTER_CASE_STATUSES.filter(
      (status) => MANDATED_REPORTER_STATUS_TRANSITIONS[status].length === 0,
    );
    expect(terminal).toEqual([MANDATED_REPORTER_TERMINAL_STATUS]);
  });

  it('keeps not_reportable non-terminal — a negative determination still needs review', () => {
    expect(canTransition('not_reportable', 'signed_off')).toBe(true);
    expect(canTransition('not_reportable', 'filing_prep')).toBe(true);
  });

  it('reaches filed only through filing_prep, which is the verified-jurisdiction gate', () => {
    const intoFiled = MANDATED_REPORTER_CASE_STATUSES.filter((from) =>
      canTransition(from, 'filed'),
    );
    expect(intoFiled).toEqual(['filing_prep']);
  });

  it('never allows a self-transition', () => {
    for (const status of MANDATED_REPORTER_CASE_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('never allows screening to be re-entered', () => {
    const intoScreening = MANDATED_REPORTER_CASE_STATUSES.filter((from) =>
      canTransition(from, 'screening'),
    );
    expect(intoScreening).toEqual([]);
  });
});

describe('US_JURISDICTION_CODES', () => {
  it('covers the 50 states, DC, and the five inhabited territories', () => {
    expect(US_JURISDICTION_CODES).toHaveLength(56);
  });

  it('holds no duplicates', () => {
    expect(new Set(US_JURISDICTION_CODES).size).toBe(US_JURISDICTION_CODES.length);
  });

  it('is uppercase two-letter codes only', () => {
    for (const code of US_JURISDICTION_CODES) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('accepts real codes and rejects near-misses', () => {
    expect(isUsJurisdictionCode('NY')).toBe(true);
    expect(isUsJurisdictionCode('PR')).toBe(true);
    expect(isUsJurisdictionCode('ny')).toBe(false);
    expect(isUsJurisdictionCode('XX')).toBe(false);
    expect(isUsJurisdictionCode('')).toBe(false);
  });
});
