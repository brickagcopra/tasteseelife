import { describe, expect, it } from 'vitest';

import {
  AdvanceMandatedReporterCaseRequestSchema,
  canAdvanceMandatedReporterCase,
  isUsJurisdictionCode,
  ListMandatedReporterCasesQuerySchema,
  MANDATED_REPORTER_CASE_STATUSES,
  MANDATED_REPORTER_CASE_QUEUE_LIMIT_DEFAULT,
  MANDATED_REPORTER_CASE_QUEUE_LIMIT_MAX,
  MANDATED_REPORTER_FILING_REFERENCE_MAX_LENGTH,
  MANDATED_REPORTER_NOTES_MAX_LENGTH,
  MandatedReporterCaseListResponseSchema,
  MandatedReporterCaseRecordSchema,
  MANDATED_REPORTER_STATUS_TRANSITIONS,
  MANDATED_REPORTER_TERMINAL_STATUS,
  MandatedReporterCaseStatusSchema,
  MandatedReporterCaseSummarySchema,
  MandatedReporterCaseTransitionSchema,
  OpenMandatedReporterCaseRequestSchema,
  ResolveIncidentRequestSchema,
  SetMandatedReporterJurisdictionVerificationRequestSchema,
  TRUST_SAFETY_RESOLUTION_NOTES_MAX_LENGTH,
  US_JURISDICTION_CODES,
  UpsertMandatedReporterJurisdictionRequestSchema,
} from '../http/trust-safety-mandated-reporter.schema';

/**
 * Contract tests for the mandated-reporter workflow DTOs (TS-303b / c1 /
 * c2a). The queue shapes are new here; the older request shapes had no
 * dedicated test file, so the load-bearing ones are pinned at the same time.
 *
 * The assertion that matters most in this file is the PHI one: the queue
 * summary must NOT carry `determinationNotes` / `reviewerNotes`. Those are an
 * operator's free-text account of a named senior's suspected abuse, and the
 * only reason the summary shape exists at all is to keep them off a list read
 * (CLAUDE.md §3.9).
 */

const CASE_SUMMARY = {
  id: 'mrc_abc123',
  incidentId: 'inc_abc123',
  stateCode: 'NY',
  status: 'screening',
  openedByUserId: 'usr_opener',
  openedAt: '2026-07-25T10:00:00.000Z',
  statutoryDueAt: '2026-07-27T10:00:00.000Z',
  filedAt: null,
  filingReference: null,
  reviewerUserId: null,
  reviewedAt: null,
} as const;

describe('MandatedReporterCaseSummarySchema', () => {
  it('accepts a queue row', () => {
    expect(MandatedReporterCaseSummarySchema.safeParse(CASE_SUMMARY).success).toBe(true);
  });

  it('accepts a null statutory deadline — an unestablished state window', () => {
    expect(
      MandatedReporterCaseSummarySchema.safeParse({ ...CASE_SUMMARY, statutoryDueAt: null })
        .success,
    ).toBe(true);
  });

  it('rejects determinationNotes — PHI must not ride on a list read', () => {
    const withNotes = { ...CASE_SUMMARY, determinationNotes: 'she flinched when he entered' };
    expect(MandatedReporterCaseSummarySchema.safeParse(withNotes).success).toBe(false);
  });

  it('rejects reviewerNotes for the same reason', () => {
    const withNotes = { ...CASE_SUMMARY, reviewerNotes: 'concur with the determination' };
    expect(MandatedReporterCaseSummarySchema.safeParse(withNotes).success).toBe(false);
  });

  it('carries every field the detail record does except the two notes fields', () => {
    const detailKeys = Object.keys(MandatedReporterCaseRecordSchema.shape).filter(
      (key) => key !== 'determinationNotes' && key !== 'reviewerNotes',
    );
    expect(Object.keys(MandatedReporterCaseSummarySchema.shape).sort()).toEqual(detailKeys.sort());
  });

  it('accepts every case status', () => {
    for (const status of ['screening', 'filing_prep', 'filed', 'not_reportable', 'signed_off']) {
      expect(MandatedReporterCaseSummarySchema.safeParse({ ...CASE_SUMMARY, status }).success).toBe(
        true,
      );
    }
  });
});

describe('ListMandatedReporterCasesQuerySchema', () => {
  it('defaults the limit when absent', () => {
    const parsed = ListMandatedReporterCasesQuerySchema.parse({});
    expect(parsed.limit).toBe(MANDATED_REPORTER_CASE_QUEUE_LIMIT_DEFAULT);
    expect(parsed.status).toBeUndefined();
    expect(parsed.stateCode).toBeUndefined();
  });

  it('coerces a string limit from the query string', () => {
    expect(ListMandatedReporterCasesQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  it('bounds the limit', () => {
    expect(
      ListMandatedReporterCasesQuerySchema.safeParse({
        limit: MANDATED_REPORTER_CASE_QUEUE_LIMIT_MAX,
      }).success,
    ).toBe(true);
    expect(
      ListMandatedReporterCasesQuerySchema.safeParse({
        limit: MANDATED_REPORTER_CASE_QUEUE_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
    expect(ListMandatedReporterCasesQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('accepts an explicit signed_off filter — the closed set stays reachable', () => {
    expect(ListMandatedReporterCasesQuerySchema.parse({ status: 'signed_off' }).status).toBe(
      'signed_off',
    );
  });

  it('rejects an unknown status', () => {
    expect(ListMandatedReporterCasesQuerySchema.safeParse({ status: 'closed' }).success).toBe(
      false,
    );
  });

  it('rejects a state code that is not two characters', () => {
    expect(ListMandatedReporterCasesQuerySchema.safeParse({ stateCode: 'NYC' }).success).toBe(
      false,
    );
    expect(ListMandatedReporterCasesQuerySchema.safeParse({ stateCode: 'ny' }).success).toBe(true);
  });

  it('rejects unknown query keys', () => {
    expect(ListMandatedReporterCasesQuerySchema.safeParse({ offset: 10 }).success).toBe(false);
  });
});

describe('MandatedReporterCaseListResponseSchema', () => {
  it('accepts an empty queue', () => {
    expect(MandatedReporterCaseListResponseSchema.safeParse({ cases: [] }).success).toBe(true);
  });

  it('accepts a populated queue', () => {
    expect(
      MandatedReporterCaseListResponseSchema.safeParse({ cases: [CASE_SUMMARY] }).success,
    ).toBe(true);
  });

  it('rejects unknown envelope keys', () => {
    expect(
      MandatedReporterCaseListResponseSchema.safeParse({ cases: [], nextCursor: null }).success,
    ).toBe(false);
  });
});

describe('OpenMandatedReporterCaseRequestSchema', () => {
  const valid = { incidentId: 'inc_abc123', stateCode: 'NY' };

  it('accepts the minimal shape', () => {
    expect(OpenMandatedReporterCaseRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a lowercase state code — the service normalises', () => {
    expect(
      OpenMandatedReporterCaseRequestSchema.safeParse({ ...valid, stateCode: 'ny' }).success,
    ).toBe(true);
  });

  it('bounds determinationNotes', () => {
    const atCap = {
      ...valid,
      determinationNotes: 'x'.repeat(MANDATED_REPORTER_NOTES_MAX_LENGTH),
    };
    expect(OpenMandatedReporterCaseRequestSchema.safeParse(atCap).success).toBe(true);
    expect(
      OpenMandatedReporterCaseRequestSchema.safeParse({
        ...valid,
        determinationNotes: 'x'.repeat(MANDATED_REPORTER_NOTES_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects a client-supplied opener — the four-eyes id comes from the token', () => {
    expect(
      OpenMandatedReporterCaseRequestSchema.safeParse({ ...valid, openedByUserId: 'usr_x' })
        .success,
    ).toBe(false);
  });
});

describe('AdvanceMandatedReporterCaseRequestSchema', () => {
  it('omits screening from the transition enum', () => {
    expect(MandatedReporterCaseTransitionSchema.safeParse('screening').success).toBe(false);
    expect(AdvanceMandatedReporterCaseRequestSchema.safeParse({ to: 'screening' }).success).toBe(
      false,
    );
  });

  it('accepts each reachable transition', () => {
    for (const to of ['filing_prep', 'filed', 'not_reportable', 'signed_off']) {
      expect(AdvanceMandatedReporterCaseRequestSchema.safeParse({ to }).success).toBe(true);
    }
  });

  it('bounds the filing reference', () => {
    expect(
      AdvanceMandatedReporterCaseRequestSchema.safeParse({
        to: 'filed',
        filingReference: 'x'.repeat(MANDATED_REPORTER_FILING_REFERENCE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('does not enforce the filed/filingReference pairing at the boundary', () => {
    // Deliberate: the service raises it so the 400 names the field in the
    // operator's language rather than as a Zod refinement path.
    expect(AdvanceMandatedReporterCaseRequestSchema.safeParse({ to: 'filed' }).success).toBe(true);
  });
});

describe('ResolveIncidentRequestSchema', () => {
  it('requires a resolution note — no closing with a shrug', () => {
    expect(ResolveIncidentRequestSchema.safeParse({}).success).toBe(false);
    expect(ResolveIncidentRequestSchema.safeParse({ resolutionNotes: '   ' }).success).toBe(false);
  });

  it('bounds the resolution note', () => {
    expect(
      ResolveIncidentRequestSchema.safeParse({
        resolutionNotes: 'x'.repeat(TRUST_SAFETY_RESOLUTION_NOTES_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe('UpsertMandatedReporterJurisdictionRequestSchema', () => {
  it('accepts an empty edit', () => {
    expect(UpsertMandatedReporterJurisdictionRequestSchema.safeParse({}).success).toBe(true);
  });

  it('rejects `verified` — attestation is its own route, never a field on an edit', () => {
    expect(
      UpsertMandatedReporterJurisdictionRequestSchema.safeParse({ verified: true }).success,
    ).toBe(false);
  });

  it('rejects a non-URL reporting portal', () => {
    expect(
      UpsertMandatedReporterJurisdictionRequestSchema.safeParse({ reportingUrl: 'aps hotline' })
        .success,
    ).toBe(false);
  });

  it('bounds the statutory deadline to a year of hours', () => {
    expect(
      UpsertMandatedReporterJurisdictionRequestSchema.safeParse({ statutoryDeadlineHours: 8_760 })
        .success,
    ).toBe(true);
    expect(
      UpsertMandatedReporterJurisdictionRequestSchema.safeParse({ statutoryDeadlineHours: 8_761 })
        .success,
    ).toBe(false);
    expect(
      UpsertMandatedReporterJurisdictionRequestSchema.safeParse({ statutoryDeadlineHours: 0 })
        .success,
    ).toBe(false);
  });
});

describe('SetMandatedReporterJurisdictionVerificationRequestSchema', () => {
  it('treats withdrawal as first-class', () => {
    expect(
      SetMandatedReporterJurisdictionVerificationRequestSchema.safeParse({ verified: false })
        .success,
    ).toBe(true);
  });

  it('requires the flag', () => {
    expect(
      SetMandatedReporterJurisdictionVerificationRequestSchema.safeParse({ notes: 'checked' })
        .success,
    ).toBe(false);
  });
});

describe('MANDATED_REPORTER_STATUS_TRANSITIONS (single-sourced for service + console)', () => {
  it('covers every status in the enum, and only those', () => {
    expect([...MANDATED_REPORTER_CASE_STATUSES].sort()).toEqual(
      [...MandatedReporterCaseStatusSchema.options].sort(),
    );
  });

  it('makes signed_off the only terminal state', () => {
    for (const status of MANDATED_REPORTER_CASE_STATUSES) {
      const isTerminal = MANDATED_REPORTER_STATUS_TRANSITIONS[status].length === 0;
      expect(isTerminal).toBe(status === MANDATED_REPORTER_TERMINAL_STATUS);
    }
  });

  it('keeps not_reportable non-terminal — a negative determination still needs a second pair of eyes', () => {
    expect(MANDATED_REPORTER_STATUS_TRANSITIONS.not_reportable).toContain('signed_off');
    expect(MANDATED_REPORTER_STATUS_TRANSITIONS.not_reportable).toContain('filing_prep');
  });

  it('reaches filed only from filing_prep — a filing must have been prepared', () => {
    const reachFiled = MANDATED_REPORTER_CASE_STATUSES.filter((from) =>
      MANDATED_REPORTER_STATUS_TRANSITIONS[from].includes('filed'),
    );
    expect(reachFiled).toEqual(['filing_prep']);
  });

  it('lets nothing transition back into screening', () => {
    for (const status of MANDATED_REPORTER_CASE_STATUSES) {
      expect(MANDATED_REPORTER_STATUS_TRANSITIONS[status]).not.toContain('screening');
    }
  });

  it('agrees with canAdvanceMandatedReporterCase across the whole matrix', () => {
    for (const from of MANDATED_REPORTER_CASE_STATUSES) {
      for (const to of MANDATED_REPORTER_CASE_STATUSES) {
        expect(canAdvanceMandatedReporterCase(from, to)).toBe(
          MANDATED_REPORTER_STATUS_TRANSITIONS[from].includes(to),
        );
      }
    }
  });

  it('only ever targets statuses the transition request schema accepts', () => {
    // The console builds its action list from this matrix; a target the wire
    // shape rejects would render a button that 400s.
    for (const from of MANDATED_REPORTER_CASE_STATUSES) {
      for (const to of MANDATED_REPORTER_STATUS_TRANSITIONS[from]) {
        expect(MandatedReporterCaseTransitionSchema.safeParse(to).success).toBe(true);
      }
    }
  });
});

describe('US_JURISDICTION_CODES', () => {
  it('carries the 50 states plus DC plus the five inhabited territories', () => {
    expect(US_JURISDICTION_CODES).toHaveLength(56);
  });

  it('recognises a real code and rejects a plausible non-code', () => {
    expect(isUsJurisdictionCode('NY')).toBe(true);
    expect(isUsJurisdictionCode('PR')).toBe(true);
    expect(isUsJurisdictionCode('ZZ')).toBe(false);
    expect(isUsJurisdictionCode('ny')).toBe(false);
  });

  it('has no duplicates', () => {
    expect(new Set(US_JURISDICTION_CODES).size).toBe(US_JURISDICTION_CODES.length);
  });
});
