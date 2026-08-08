import { describe, expect, it } from 'vitest';

import {
  AdminReportConcernRequestSchema,
  ReportConcernReceiptSchema,
  ReportConcernRequestSchema,
  ReportConcernResponseSchema,
  ListTrustSafetyIncidentsQuerySchema,
  TRUST_SAFETY_INCIDENT_QUEUE_LIMIT_DEFAULT,
  TRUST_SAFETY_INCIDENT_QUEUE_LIMIT_MAX,
  TRUST_SAFETY_REPORT_DESCRIPTION_MAX_LENGTH,
  TrustSafetyIncidentListResponseSchema,
  TrustSafetyIncidentRecordSchema,
  TrustSafetyIncidentSummarySchema,
} from '../http/trust-safety-incident.schema';

/**
 * Contract tests for the trust & safety incident-intake DTOs (TS-301a).
 *
 * Pins the request shape (category enum + required bounded description +
 * optional seniorId, `.strict()`), and the deliberately minimal filer
 * receipt — severity / SLA / triage status must never leak into the
 * filer-facing response shape.
 */
describe('ReportConcernRequestSchema', () => {
  const valid = {
    category: 'welfare',
    description: 'Mom seemed frightened of her afternoon visitor and would not say why.',
  };

  it('accepts a valid welfare concern', () => {
    expect(ReportConcernRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts every category', () => {
    for (const category of ['welfare', 'safety', 'billing', 'conduct']) {
      expect(ReportConcernRequestSchema.safeParse({ ...valid, category }).success).toBe(true);
    }
  });

  it('accepts an optional seniorId', () => {
    expect(
      ReportConcernRequestSchema.safeParse({ ...valid, seniorId: 'senior_abc123' }).success,
    ).toBe(true);
  });

  it('requires a description', () => {
    expect(ReportConcernRequestSchema.safeParse({ category: 'welfare' }).success).toBe(false);
    expect(
      ReportConcernRequestSchema.safeParse({ category: 'welfare', description: '   ' }).success,
    ).toBe(false);
  });

  it('bounds the description length', () => {
    const atCap = {
      ...valid,
      description: 'x'.repeat(TRUST_SAFETY_REPORT_DESCRIPTION_MAX_LENGTH),
    };
    expect(ReportConcernRequestSchema.safeParse(atCap).success).toBe(true);
    const overCap = {
      ...valid,
      description: 'x'.repeat(TRUST_SAFETY_REPORT_DESCRIPTION_MAX_LENGTH + 1),
    };
    expect(ReportConcernRequestSchema.safeParse(overCap).success).toBe(false);
  });

  it('rejects an unknown category', () => {
    expect(ReportConcernRequestSchema.safeParse({ ...valid, category: 'other' }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields (strict)', () => {
    expect(ReportConcernRequestSchema.safeParse({ ...valid, householdId: 'hh_1' }).success).toBe(
      false,
    );
    expect(ReportConcernRequestSchema.safeParse({ ...valid, severity: 'critical' }).success).toBe(
      false,
    );
  });
});

describe('ReportConcernReceiptSchema / ReportConcernResponseSchema', () => {
  const receipt = {
    incidentId: 'inc_abc123',
    category: 'safety',
    openedAt: '2026-07-02T12:00:00.000Z',
  };

  it('accepts a minimal receipt', () => {
    expect(ReportConcernReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(ReportConcernResponseSchema.safeParse({ receipt }).success).toBe(true);
  });

  it('rejects internal triage fields on the receipt (strict) — the filer never sees them', () => {
    for (const leak of [
      { severity: 'high' },
      { slaDueAt: '2026-07-02T20:00:00.000Z' },
      { status: 'open' },
      { householdId: 'hh_1' },
    ]) {
      expect(ReportConcernReceiptSchema.safeParse({ ...receipt, ...leak }).success).toBe(false);
    }
  });

  it('requires an offset-stamped openedAt', () => {
    expect(
      ReportConcernReceiptSchema.safeParse({ ...receipt, openedAt: 'yesterday' }).success,
    ).toBe(false);
  });
});

/**
 * TS-301b — the concierge on-behalf shape. The load-bearing property is the
 * ASYMMETRY with the filer-facing schema: exactly one of the two accepts a
 * body `householdId`, and that difference is the trust boundary. These tests
 * pin it from both sides so a future "let's just merge them into one schema
 * with an optional householdId" refactor fails loudly.
 */
describe('AdminReportConcernRequestSchema', () => {
  const valid = {
    householdId: 'hh_5',
    category: 'welfare' as const,
    description: 'Daughter called the concierge line about a missed visit.',
  };

  it('accepts a body-supplied householdId — the on-behalf path', () => {
    expect(AdminReportConcernRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('requires the householdId — an on-behalf report with no subject is meaningless', () => {
    const { householdId: _omitted, ...withoutHousehold } = valid;
    expect(AdminReportConcernRequestSchema.safeParse(withoutHousehold).success).toBe(false);
    expect(AdminReportConcernRequestSchema.safeParse({ ...valid, householdId: '' }).success).toBe(
      false,
    );
    expect(
      AdminReportConcernRequestSchema.safeParse({ ...valid, householdId: '   ' }).success,
    ).toBe(false);
  });

  it('the FILER-facing schema still rejects a body householdId (the trust boundary)', () => {
    expect(
      ReportConcernRequestSchema.safeParse({
        category: 'welfare',
        description: 'something happened',
        householdId: 'hh_someone_elses',
      }).success,
    ).toBe(false);
  });

  it('neither schema accepts a self-asserted providerId', () => {
    const withProvider = { category: 'conduct', description: 'x', providerId: 'prov_9' };
    expect(ReportConcernRequestSchema.safeParse(withProvider).success).toBe(false);
    expect(
      AdminReportConcernRequestSchema.safeParse({ ...withProvider, householdId: 'hh_5' }).success,
    ).toBe(false);
  });

  it('carries the same category / description / seniorId bounds as the filer schema', () => {
    expect(AdminReportConcernRequestSchema.safeParse({ ...valid, category: 'nope' }).success).toBe(
      false,
    );
    expect(AdminReportConcernRequestSchema.safeParse({ ...valid, description: '' }).success).toBe(
      false,
    );
    expect(
      AdminReportConcernRequestSchema.safeParse({
        ...valid,
        description: 'x'.repeat(TRUST_SAFETY_REPORT_DESCRIPTION_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(AdminReportConcernRequestSchema.safeParse({ ...valid, seniorId: 'sen_2' }).success).toBe(
      true,
    );
  });
});

// ─── Operator incident queue + detail (TS-303c2d) ───────────────────────

const INCIDENT_SUMMARY = {
  id: 'inc_abc123',
  source: 'family',
  category: 'welfare',
  severity: 'high',
  status: 'open',
  householdId: 'hh_1',
  seniorId: 'sen_1',
  providerId: null,
  reporterUserId: 'usr_filer',
  openedAt: '2026-07-25T10:00:00.000Z',
  slaDueAt: '2026-07-25T18:00:00.000Z',
  resolvedAt: null,
  hasMandatedReporterCase: false,
} as const;

describe('TrustSafetyIncidentSummarySchema', () => {
  it('accepts a queue row', () => {
    expect(TrustSafetyIncidentSummarySchema.safeParse(INCIDENT_SUMMARY).success).toBe(true);
  });

  it('rejects `description` — the filer narrative must not ride a list read', () => {
    expect(
      TrustSafetyIncidentSummarySchema.safeParse({
        ...INCIDENT_SUMMARY,
        description: 'she seemed frightened',
      }).success,
    ).toBe(false);
  });

  it('rejects `resolutionNotes` for the same reason', () => {
    expect(
      TrustSafetyIncidentSummarySchema.safeParse({
        ...INCIDENT_SUMMARY,
        resolutionNotes: 'closed after a welfare check',
      }).success,
    ).toBe(false);
  });

  it('requires the statutory-pathway flag — the queue must show what cannot be closed', () => {
    const { hasMandatedReporterCase: _omitted, ...withoutFlag } = INCIDENT_SUMMARY;
    expect(TrustSafetyIncidentSummarySchema.safeParse(withoutFlag).success).toBe(false);
  });

  it('allows every subject id to be null — not every incident has a household', () => {
    expect(
      TrustSafetyIncidentSummarySchema.safeParse({
        ...INCIDENT_SUMMARY,
        householdId: null,
        seniorId: null,
        providerId: null,
        reporterUserId: null,
      }).success,
    ).toBe(true);
  });

  it('requires a non-null slaDueAt — every severity has a budget', () => {
    expect(
      TrustSafetyIncidentSummarySchema.safeParse({ ...INCIDENT_SUMMARY, slaDueAt: null }).success,
    ).toBe(false);
  });

  it('accepts every status, severity and source', () => {
    for (const status of ['open', 'triaging', 'awaiting_review', 'resolved']) {
      expect(
        TrustSafetyIncidentSummarySchema.safeParse({ ...INCIDENT_SUMMARY, status }).success,
      ).toBe(true);
    }
    for (const severity of ['low', 'medium', 'high', 'critical']) {
      expect(
        TrustSafetyIncidentSummarySchema.safeParse({ ...INCIDENT_SUMMARY, severity }).success,
      ).toBe(true);
    }
    for (const source of ['family', 'senior', 'provider', 'concierge', 'system']) {
      expect(
        TrustSafetyIncidentSummarySchema.safeParse({ ...INCIDENT_SUMMARY, source }).success,
      ).toBe(true);
    }
  });
});

describe('TrustSafetyIncidentRecordSchema', () => {
  const detail = {
    ...INCIDENT_SUMMARY,
    description: 'she seemed frightened of her afternoon visitor',
    resolutionNotes: null,
    // TS-307a-followup-1 / TS-308c-followup-2 — the system-intake trail.
    // Null on a human-filed report, which is what this fixture is.
    sourceEventId: null,
    detector: null,
    systemEvidence: null,
  };

  it('accepts the summary plus the free-text fields and the system trail', () => {
    expect(TrustSafetyIncidentRecordSchema.safeParse(detail).success).toBe(true);
  });

  it('is exactly the summary plus the detail-only fields', () => {
    expect(Object.keys(TrustSafetyIncidentRecordSchema.shape).sort()).toEqual(
      [
        ...Object.keys(TrustSafetyIncidentSummarySchema.shape),
        'description',
        'resolutionNotes',
        // Detail-only, and deliberately NOT on the queue: a list read has
        // no business pulling a JSONB blob per row for something the queue
        // does not render.
        'sourceEventId',
        'detector',
        'systemEvidence',
      ].sort(),
    );
  });

  it('accepts a system-opened incident carrying its detector and evidence', () => {
    expect(
      TrustSafetyIncidentRecordSchema.safeParse({
        ...detail,
        source: 'system',
        description: null,
        reporterUserId: null,
        sourceEventId: 'mass-cancellation:provider:prv_1:2026-07-26',
        detector: 'mass_cancellation',
        systemEvidence: {
          detector: 'mass_cancellation',
          subjectKind: 'provider',
          windowStart: '2026-07-25T18:00:00.000Z',
          windowEnd: '2026-07-26T18:00:00.000Z',
          canceledBookingCount: 9,
          distinctCancellationCount: 6,
          threshold: 5,
          distinctActorCount: 1,
          unattributedCount: 0,
          staffExcludedCount: 0,
        },
      }).success,
    ).toBe(true);
  });

  it('rejects evidence whose discriminator and body disagree', () => {
    // The union is what keeps free text out of the evidence column; a
    // mismatched variant must not fall through to a laxer one.
    expect(
      TrustSafetyIncidentRecordSchema.safeParse({
        ...detail,
        detector: 'impossible_travel',
        systemEvidence: { detector: 'impossible_travel', threshold: 5 },
      }).success,
    ).toBe(false);
  });

  it('rejects free text smuggled into the evidence', () => {
    expect(
      TrustSafetyIncidentRecordSchema.safeParse({
        ...detail,
        detector: 'mass_cancellation',
        systemEvidence: {
          detector: 'mass_cancellation',
          subjectKind: 'provider',
          windowStart: '2026-07-25T18:00:00.000Z',
          windowEnd: '2026-07-26T18:00:00.000Z',
          canceledBookingCount: 9,
          distinctCancellationCount: 6,
          threshold: 5,
          distinctActorCount: 1,
          unattributedCount: 0,
          staffExcludedCount: 0,
          note: 'the family said she was confused',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects the row timestamps — they are not part of the operator view', () => {
    expect(
      TrustSafetyIncidentRecordSchema.safeParse({
        ...detail,
        createdAt: '2026-07-25T10:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('allows a system-sourced incident to carry no description', () => {
    expect(
      TrustSafetyIncidentRecordSchema.safeParse({ ...detail, description: null }).success,
    ).toBe(true);
  });
});

describe('ListTrustSafetyIncidentsQuerySchema', () => {
  it('defaults the limit and leaves every filter undefined', () => {
    const parsed = ListTrustSafetyIncidentsQuerySchema.parse({});
    expect(parsed.limit).toBe(TRUST_SAFETY_INCIDENT_QUEUE_LIMIT_DEFAULT);
    expect(parsed.status).toBeUndefined();
    expect(parsed.providerId).toBeUndefined();
  });

  it('coerces a string limit and bounds it', () => {
    expect(ListTrustSafetyIncidentsQuerySchema.parse({ limit: '25' }).limit).toBe(25);
    expect(
      ListTrustSafetyIncidentsQuerySchema.safeParse({
        limit: TRUST_SAFETY_INCIDENT_QUEUE_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
    expect(ListTrustSafetyIncidentsQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('accepts an explicit resolved filter — the closed set stays reachable', () => {
    expect(ListTrustSafetyIncidentsQuerySchema.parse({ status: 'resolved' }).status).toBe(
      'resolved',
    );
  });

  it('accepts each of the three 360-view subject scrolls', () => {
    for (const key of ['householdId', 'seniorId', 'providerId'] as const) {
      expect(ListTrustSafetyIncidentsQuerySchema.safeParse({ [key]: 'x_1' }).success).toBe(true);
    }
  });

  it('rejects unknown keys and unknown enum values', () => {
    expect(ListTrustSafetyIncidentsQuerySchema.safeParse({ orderBy: 'severity' }).success).toBe(
      false,
    );
    expect(
      ListTrustSafetyIncidentsQuerySchema.safeParse({ severity: 'catastrophic' }).success,
    ).toBe(false);
    expect(ListTrustSafetyIncidentsQuerySchema.safeParse({ category: 'abuse' }).success).toBe(
      false,
    );
  });
});

describe('TrustSafetyIncidentListResponseSchema', () => {
  it('accepts an empty and a populated queue', () => {
    expect(TrustSafetyIncidentListResponseSchema.safeParse({ incidents: [] }).success).toBe(true);
    expect(
      TrustSafetyIncidentListResponseSchema.safeParse({ incidents: [INCIDENT_SUMMARY] }).success,
    ).toBe(true);
  });

  it('rejects unknown envelope keys', () => {
    expect(
      TrustSafetyIncidentListResponseSchema.safeParse({ incidents: [], total: 0 }).success,
    ).toBe(false);
  });
});
