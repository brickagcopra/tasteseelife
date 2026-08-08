import { describe, expect, it } from 'vitest';

import {
  CONCIERGE_ENRICHMENT_HEADLINE_MAX_LENGTH,
  CONCIERGE_ENRICHMENT_NOTES_MAX_LENGTH,
  CONCIERGE_ENRICHMENT_SECTION_MAX_LENGTH,
  CONCIERGE_ENRICHMENT_SUMMARIES_LIST_LIMIT_DEFAULT,
  CONCIERGE_ENRICHMENT_SUMMARIES_LIST_LIMIT_MAX,
  CONCIERGE_ENRICHMENT_SUMMARY_STATUS_TRANSITIONS,
  ConciergeEnrichmentSummariesListResponseSchema,
  ConciergeEnrichmentSummaryRecordSchema,
  ConciergeEnrichmentSummaryStatusSchema,
  ConciergeEnrichmentWeekStartDateSchema,
  CreateConciergeEnrichmentSummaryRequestSchema,
  GetConciergeEnrichmentSummaryResponseSchema,
  ListConciergeEnrichmentSummariesQuerySchema,
  MyConciergeEnrichmentSummariesQuerySchema,
  MyConciergeEnrichmentSummariesResponseSchema,
  MyConciergeEnrichmentSummaryResponseSchema,
  UpdateConciergeEnrichmentSummaryRequestSchema,
  canTransitionConciergeEnrichmentSummary,
  isConciergeEnrichmentSummaryFamilyVisible,
  type ConciergeEnrichmentSummaryStatus,
} from '../http/concierge-enrichment-summary.schema';

const NOW = '2026-05-26T15:00:00.000Z';
// 2026-05-25 is a Monday.
const MONDAY = '2026-05-25';

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sum_abc123',
    householdId: 'hh_abc123',
    weekStartDate: MONDAY,
    status: 'published',
    headline: 'A warm week of good food and company',
    visitHighlights: 'Three companion-dining visits; the osso buco was a hit.',
    wellnessSignals: 'Appetite steady, mood bright, walking unaided.',
    socialEngagement: 'Joined the Tuesday tea social; called her sister.',
    additionalNotes: null,
    authoredByUserId: 'usr_concierge',
    publishedAt: NOW,
    publishedByUserId: 'usr_concierge',
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('ConciergeEnrichmentSummaryStatusSchema', () => {
  it.each(['draft', 'published', 'archived'])('accepts %s', (status) => {
    expect(ConciergeEnrichmentSummaryStatusSchema.parse(status)).toBe(status);
  });

  it('rejects an unknown status', () => {
    expect(ConciergeEnrichmentSummaryStatusSchema.safeParse('hidden').success).toBe(false);
  });
});

describe('ConciergeEnrichmentWeekStartDateSchema', () => {
  it('accepts a Monday', () => {
    expect(ConciergeEnrichmentWeekStartDateSchema.parse(MONDAY)).toBe(MONDAY);
  });

  it('rejects a non-Monday weekday (2026-05-26 is a Tuesday)', () => {
    const result = ConciergeEnrichmentWeekStartDateSchema.safeParse('2026-05-26');
    expect(result.success).toBe(false);
  });

  it('rejects a non-existent calendar date', () => {
    expect(ConciergeEnrichmentWeekStartDateSchema.safeParse('2026-02-30').success).toBe(false);
  });

  it('rejects a malformed date string', () => {
    expect(ConciergeEnrichmentWeekStartDateSchema.safeParse('2026-5-25').success).toBe(false);
    expect(ConciergeEnrichmentWeekStartDateSchema.safeParse('not-a-date').success).toBe(false);
  });
});

describe('status transition helpers', () => {
  it('exposes a transition map where each state reaches the other two', () => {
    expect(CONCIERGE_ENRICHMENT_SUMMARY_STATUS_TRANSITIONS.draft).toEqual([
      'published',
      'archived',
    ]);
    expect(CONCIERGE_ENRICHMENT_SUMMARY_STATUS_TRANSITIONS.published).toEqual([
      'draft',
      'archived',
    ]);
    expect(CONCIERGE_ENRICHMENT_SUMMARY_STATUS_TRANSITIONS.archived).toEqual([
      'draft',
      'published',
    ]);
  });

  it('allows every distinct transition and forbids self-transitions', () => {
    const statuses: ConciergeEnrichmentSummaryStatus[] = ['draft', 'published', 'archived'];
    for (const from of statuses) {
      for (const to of statuses) {
        expect(canTransitionConciergeEnrichmentSummary(from, to)).toBe(from !== to);
      }
    }
  });

  it('marks only published as family-visible', () => {
    expect(isConciergeEnrichmentSummaryFamilyVisible('published')).toBe(true);
    expect(isConciergeEnrichmentSummaryFamilyVisible('draft')).toBe(false);
    expect(isConciergeEnrichmentSummaryFamilyVisible('archived')).toBe(false);
  });
});

describe('ConciergeEnrichmentSummaryRecordSchema', () => {
  it('accepts a fully-populated published record', () => {
    expect(ConciergeEnrichmentSummaryRecordSchema.safeParse(validRecord()).success).toBe(true);
  });

  it('accepts a draft record with null publish/archive stamps', () => {
    const draft = validRecord({
      status: 'draft',
      publishedAt: null,
      publishedByUserId: null,
      archivedAt: null,
    });
    expect(ConciergeEnrichmentSummaryRecordSchema.safeParse(draft).success).toBe(true);
  });

  it('accepts a populated additionalNotes', () => {
    const record = validRecord({ additionalNotes: 'Family requested more Italian dishes.' });
    expect(ConciergeEnrichmentSummaryRecordSchema.safeParse(record).success).toBe(true);
  });

  it('rejects an unknown field (.strict)', () => {
    expect(
      ConciergeEnrichmentSummaryRecordSchema.safeParse(validRecord({ extra: 'nope' })).success,
    ).toBe(false);
  });

  it('rejects an empty narrative section', () => {
    expect(
      ConciergeEnrichmentSummaryRecordSchema.safeParse(validRecord({ visitHighlights: '' }))
        .success,
    ).toBe(false);
  });
});

describe('CreateConciergeEnrichmentSummaryRequestSchema', () => {
  function validCreate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      householdId: 'hh_abc123',
      weekStartDate: MONDAY,
      headline: 'A warm week',
      visitHighlights: 'Two visits this week.',
      wellnessSignals: 'Steady and bright.',
      socialEngagement: 'Tea social on Tuesday.',
      ...overrides,
    };
  }

  it('accepts a minimal create body (no additionalNotes)', () => {
    expect(CreateConciergeEnrichmentSummaryRequestSchema.safeParse(validCreate()).success).toBe(
      true,
    );
  });

  it('accepts an additionalNotes string', () => {
    expect(
      CreateConciergeEnrichmentSummaryRequestSchema.safeParse(
        validCreate({ additionalNotes: 'Note.' }),
      ).success,
    ).toBe(true);
  });

  it('rejects a missing required section', () => {
    const body = validCreate();
    delete body['wellnessSignals'];
    expect(CreateConciergeEnrichmentSummaryRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a non-Monday weekStartDate', () => {
    expect(
      CreateConciergeEnrichmentSummaryRequestSchema.safeParse(
        validCreate({ weekStartDate: '2026-05-26' }),
      ).success,
    ).toBe(false);
  });

  it('rejects a status field (create always starts as draft)', () => {
    expect(
      CreateConciergeEnrichmentSummaryRequestSchema.safeParse(validCreate({ status: 'published' }))
        .success,
    ).toBe(false);
  });

  it('rejects a headline over the cap', () => {
    expect(
      CreateConciergeEnrichmentSummaryRequestSchema.safeParse(
        validCreate({ headline: 'x'.repeat(CONCIERGE_ENRICHMENT_HEADLINE_MAX_LENGTH + 1) }),
      ).success,
    ).toBe(false);
  });

  it('rejects a section over the cap', () => {
    expect(
      CreateConciergeEnrichmentSummaryRequestSchema.safeParse(
        validCreate({ visitHighlights: 'x'.repeat(CONCIERGE_ENRICHMENT_SECTION_MAX_LENGTH + 1) }),
      ).success,
    ).toBe(false);
  });
});

describe('UpdateConciergeEnrichmentSummaryRequestSchema', () => {
  it('accepts a single-field content edit', () => {
    expect(
      UpdateConciergeEnrichmentSummaryRequestSchema.safeParse({ headline: 'Revised' }).success,
    ).toBe(true);
  });

  it('accepts a status-only transition', () => {
    expect(
      UpdateConciergeEnrichmentSummaryRequestSchema.safeParse({ status: 'published' }).success,
    ).toBe(true);
  });

  it('accepts additionalNotes = null (clear)', () => {
    expect(
      UpdateConciergeEnrichmentSummaryRequestSchema.safeParse({ additionalNotes: null }).success,
    ).toBe(true);
  });

  it('rejects an empty body (at least one field required)', () => {
    expect(UpdateConciergeEnrichmentSummaryRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown field (.strict)', () => {
    expect(
      UpdateConciergeEnrichmentSummaryRequestSchema.safeParse({ headline: 'x', extra: 1 }).success,
    ).toBe(false);
  });

  it('rejects an over-cap additionalNotes', () => {
    expect(
      UpdateConciergeEnrichmentSummaryRequestSchema.safeParse({
        additionalNotes: 'x'.repeat(CONCIERGE_ENRICHMENT_NOTES_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe('ListConciergeEnrichmentSummariesQuerySchema', () => {
  it('defaults the limit when absent', () => {
    const parsed = ListConciergeEnrichmentSummariesQuerySchema.parse({});
    expect(parsed.limit).toBe(CONCIERGE_ENRICHMENT_SUMMARIES_LIST_LIMIT_DEFAULT);
  });

  it('coerces a string limit and accepts filters', () => {
    const parsed = ListConciergeEnrichmentSummariesQuerySchema.parse({
      householdId: 'hh_1',
      status: 'draft',
      limit: '10',
    });
    expect(parsed.limit).toBe(10);
    expect(parsed.householdId).toBe('hh_1');
    expect(parsed.status).toBe('draft');
  });

  it('rejects a limit over the max', () => {
    expect(
      ListConciergeEnrichmentSummariesQuerySchema.safeParse({
        limit: String(CONCIERGE_ENRICHMENT_SUMMARIES_LIST_LIMIT_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown query param (.strict)', () => {
    expect(ListConciergeEnrichmentSummariesQuerySchema.safeParse({ sneaky: 'x' }).success).toBe(
      false,
    );
  });
});

describe('MyConciergeEnrichmentSummariesQuerySchema', () => {
  it('defaults the limit', () => {
    expect(MyConciergeEnrichmentSummariesQuerySchema.parse({}).limit).toBe(
      CONCIERGE_ENRICHMENT_SUMMARIES_LIST_LIMIT_DEFAULT,
    );
  });

  it('rejects a householdId param (family resolves it from the token)', () => {
    expect(
      MyConciergeEnrichmentSummariesQuerySchema.safeParse({ householdId: 'hh_1' }).success,
    ).toBe(false);
  });
});

describe('response envelopes', () => {
  it('GetConciergeEnrichmentSummaryResponse wraps a record', () => {
    expect(
      GetConciergeEnrichmentSummaryResponseSchema.safeParse({ summary: validRecord() }).success,
    ).toBe(true);
  });

  it('ConciergeEnrichmentSummariesListResponse wraps an array', () => {
    expect(
      ConciergeEnrichmentSummariesListResponseSchema.safeParse({ summaries: [validRecord()] })
        .success,
    ).toBe(true);
    expect(
      ConciergeEnrichmentSummariesListResponseSchema.safeParse({ summaries: [] }).success,
    ).toBe(true);
  });

  it('MyConciergeEnrichmentSummariesResponse carries householdId + array', () => {
    expect(
      MyConciergeEnrichmentSummariesResponseSchema.safeParse({
        householdId: 'hh_1',
        summaries: [validRecord()],
      }).success,
    ).toBe(true);
  });

  it('MyConciergeEnrichmentSummaryResponse allows a null summary (permalink miss)', () => {
    expect(
      MyConciergeEnrichmentSummaryResponseSchema.safeParse({ householdId: 'hh_1', summary: null })
        .success,
    ).toBe(true);
    expect(
      MyConciergeEnrichmentSummaryResponseSchema.safeParse({
        householdId: 'hh_1',
        summary: validRecord(),
      }).success,
    ).toBe(true);
  });
});
