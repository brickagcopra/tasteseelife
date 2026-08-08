import { describe, expect, it } from 'vitest';

import {
  InternalRecipientContactsRequestSchema,
  InternalRecipientContactsResponseSchema,
  InternalSeniorWellnessObservationSummaryResponseSchema,
  InternalWellnessSummaryHouseholdsQuerySchema,
  InternalWellnessSummaryHouseholdsResponseSchema,
  RecipientContactSchema,
  WELLNESS_SUMMARY_HOUSEHOLD_PAGE_LIMIT_DEFAULT,
  WELLNESS_SUMMARY_HOUSEHOLD_PAGE_LIMIT_MAX,
  WELLNESS_SUMMARY_RECIPIENT_BATCH_MAX,
  WellnessObservationMetricSummarySchema,
  WellnessSummaryHouseholdSchema,
  WellnessSummaryRecipientRoleSchema,
  WellnessSummarySeniorSchema,
} from '../http/wellness-summary.schema';

/**
 * Contract tests for the TS-235 monthly wellness-summary worker
 * internal DTOs (household batch + identity recipient-contacts + booking
 * observation summary).
 */
describe('WellnessSummaryRecipientRoleSchema', () => {
  it.each(['primary_payer', 'family_observer', 'senior_user'])('accepts the %s role', (role) => {
    expect(WellnessSummaryRecipientRoleSchema.parse(role)).toBe(role);
  });

  it('rejects an unknown role', () => {
    expect(WellnessSummaryRecipientRoleSchema.safeParse('partner_admin').success).toBe(false);
  });
});

describe('WellnessSummarySeniorSchema', () => {
  const valid = {
    seniorId: 'snr_1',
    firstName: 'Rose',
    status: 'active' as const,
    notesConsent: true,
  };

  it('accepts a well-formed senior', () => {
    expect(WellnessSummarySeniorSchema.parse(valid)).toEqual(valid);
  });

  it('requires the notesConsent flag', () => {
    const { notesConsent: _drop, ...rest } = valid;
    expect(WellnessSummarySeniorSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an empty first name', () => {
    expect(WellnessSummarySeniorSchema.safeParse({ ...valid, firstName: '' }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(WellnessSummarySeniorSchema.safeParse({ ...valid, lastName: 'Marchetti' }).success).toBe(
      false,
    );
  });
});

describe('WellnessSummaryHouseholdSchema', () => {
  const valid = {
    householdId: 'hh_1',
    seniors: [
      { seniorId: 'snr_1', firstName: 'Rose', status: 'active' as const, notesConsent: false },
    ],
    recipients: [{ userId: 'usr_1', role: 'primary_payer' as const }],
  };

  it('accepts a household with at least one senior + recipient', () => {
    expect(WellnessSummaryHouseholdSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a household with no seniors', () => {
    expect(WellnessSummaryHouseholdSchema.safeParse({ ...valid, seniors: [] }).success).toBe(false);
  });

  it('rejects a household with no recipients', () => {
    expect(WellnessSummaryHouseholdSchema.safeParse({ ...valid, recipients: [] }).success).toBe(
      false,
    );
  });
});

describe('InternalWellnessSummaryHouseholdsQuerySchema', () => {
  it('defaults the limit', () => {
    const parsed = InternalWellnessSummaryHouseholdsQuerySchema.parse({});
    expect(parsed.limit).toBe(WELLNESS_SUMMARY_HOUSEHOLD_PAGE_LIMIT_DEFAULT);
    expect(parsed.cursor).toBeUndefined();
  });

  it('coerces a string limit', () => {
    expect(InternalWellnessSummaryHouseholdsQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('rejects a limit over the max', () => {
    expect(
      InternalWellnessSummaryHouseholdsQuerySchema.safeParse({
        limit: WELLNESS_SUMMARY_HOUSEHOLD_PAGE_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
  });
});

describe('InternalWellnessSummaryHouseholdsResponseSchema', () => {
  it('accepts an empty page with a null cursor', () => {
    expect(
      InternalWellnessSummaryHouseholdsResponseSchema.parse({ households: [], nextCursor: null }),
    ).toEqual({ households: [], nextCursor: null });
  });

  it('requires nextCursor to be present (nullable, not optional)', () => {
    expect(
      InternalWellnessSummaryHouseholdsResponseSchema.safeParse({ households: [] }).success,
    ).toBe(false);
  });
});

describe('InternalRecipientContactsRequestSchema', () => {
  it('accepts a batch of userIds', () => {
    expect(InternalRecipientContactsRequestSchema.parse({ userIds: ['usr_1', 'usr_2'] })).toEqual({
      userIds: ['usr_1', 'usr_2'],
    });
  });

  it('rejects an empty batch', () => {
    expect(InternalRecipientContactsRequestSchema.safeParse({ userIds: [] }).success).toBe(false);
  });

  it('rejects a batch over the max', () => {
    const userIds = Array.from(
      { length: WELLNESS_SUMMARY_RECIPIENT_BATCH_MAX + 1 },
      (_v, i) => `usr_${i}`,
    );
    expect(InternalRecipientContactsRequestSchema.safeParse({ userIds }).success).toBe(false);
  });
});

describe('RecipientContactSchema / InternalRecipientContactsResponseSchema', () => {
  const contact = { userId: 'usr_1', email: 'rose@example.com', status: 'active' as const };

  it('accepts a valid contact', () => {
    expect(RecipientContactSchema.parse(contact)).toEqual(contact);
  });

  it('rejects a malformed email', () => {
    expect(RecipientContactSchema.safeParse({ ...contact, email: 'not-an-email' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown account status', () => {
    expect(RecipientContactSchema.safeParse({ ...contact, status: 'archived' }).success).toBe(
      false,
    );
  });

  it('wraps contacts in a list', () => {
    expect(
      InternalRecipientContactsResponseSchema.parse({ contacts: [contact] }).contacts,
    ).toHaveLength(1);
  });
});

describe('WellnessObservationMetricSummarySchema', () => {
  it('accepts an all-null (never-recorded) scale', () => {
    const parsed = WellnessObservationMetricSummarySchema.parse({
      metric: 'mood',
      latestScore: null,
      averageScore: null,
      visitsRecorded: 0,
    });
    expect(parsed.visitsRecorded).toBe(0);
  });

  it('accepts a fractional averageScore but requires an integer latestScore', () => {
    expect(
      WellnessObservationMetricSummarySchema.parse({
        metric: 'appetite',
        latestScore: 4,
        averageScore: 4.3,
        visitsRecorded: 3,
      }).averageScore,
    ).toBe(4.3);
    expect(
      WellnessObservationMetricSummarySchema.safeParse({
        metric: 'appetite',
        latestScore: 4.3,
        averageScore: 4.3,
        visitsRecorded: 3,
      }).success,
    ).toBe(false);
  });

  it('rejects a score outside 1..5', () => {
    expect(
      WellnessObservationMetricSummarySchema.safeParse({
        metric: 'hydration',
        latestScore: 6,
        averageScore: 6,
        visitsRecorded: 1,
      }).success,
    ).toBe(false);
  });
});

describe('InternalSeniorWellnessObservationSummaryResponseSchema', () => {
  const valid = {
    seniorId: 'snr_1',
    windowDays: 30 as const,
    totalCompletedVisits: 4,
    metrics: [
      { metric: 'mood' as const, latestScore: 4, averageScore: 3.8, visitsRecorded: 4 },
      {
        metric: 'social_engagement' as const,
        latestScore: null,
        averageScore: null,
        visitsRecorded: 0,
      },
    ],
    generatedAt: '2026-05-27T12:00:00.000Z',
  };

  it('accepts a well-formed summary', () => {
    expect(InternalSeniorWellnessObservationSummaryResponseSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a non-30/90 window', () => {
    expect(
      InternalSeniorWellnessObservationSummaryResponseSchema.safeParse({ ...valid, windowDays: 45 })
        .success,
    ).toBe(false);
  });

  it('rejects a non-ISO generatedAt', () => {
    expect(
      InternalSeniorWellnessObservationSummaryResponseSchema.safeParse({
        ...valid,
        generatedAt: 'last tuesday',
      }).success,
    ).toBe(false);
  });
});
