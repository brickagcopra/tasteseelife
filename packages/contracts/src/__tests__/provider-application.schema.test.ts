import { describe, expect, it } from 'vitest';

import {
  ApplicationStatusSchema,
  BackgroundCheckStatusSchema,
  ProviderApplicantSchema,
  ProviderApplicationRecordSchema,
  ProviderApplicationStatusResponseSchema,
  ProviderBackgroundCheckInternalWebhookEventSchema,
  ProviderBackgroundCheckInternalWebhookResponseSchema,
  ProviderBackgroundCheckRecordSchema,
  ProviderRecordSchema,
  ProviderStatusSchema,
  ProviderTierSchema,
  SubmitProviderApplicationRequestSchema,
  SubmitProviderApplicationResponseSchema,
} from '../http/provider-application.schema';

const VALID_APPLICANT = {
  firstName: 'Sam',
  lastName: 'Cook',
  email: 'sam@example.com',
  phone: '+15551234567',
  dob: '1980-05-12',
  ssnLast4: '1234',
  zipcode: '10021',
};

const VALID_PROFILE = {
  displayName: 'Chef Sam',
  timeZone: 'America/New_York',
  headline: 'Comfort food specialist',
};

const NOW = '2026-05-11T12:00:00.000Z';

const VALID_PROVIDER = {
  id: 'prov_abc',
  status: 'in_review',
  tier: 'basic',
  displayName: 'Chef Sam',
  headline: 'Comfort food specialist',
  bio: null,
  profilePhotoKey: null,
  videoIntroKey: null,
  timeZone: 'America/New_York',
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const VALID_APPLICATION = {
  id: 'app_abc',
  status: 'submitted',
  applicantNotes: null,
  reviewNotes: null,
  submittedAt: NOW,
  reviewedAt: null,
  withdrawnAt: null,
} as const;

const VALID_BG_CHECK = {
  id: 'bg_abc',
  status: 'pending',
  checkrCandidateId: 'cand_abc',
  checkrReportId: 'rep_abc',
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

describe('ProviderStatusSchema', () => {
  it('accepts each known status', () => {
    for (const status of ['pending', 'in_review', 'active', 'suspended', 'archived']) {
      expect(ProviderStatusSchema.parse(status)).toBe(status);
    }
  });
  it('rejects unknown status', () => {
    expect(() => ProviderStatusSchema.parse('unknown')).toThrow();
  });
});

describe('ProviderTierSchema', () => {
  it('accepts each known tier', () => {
    for (const tier of ['basic', 'certified', 'elite']) {
      expect(ProviderTierSchema.parse(tier)).toBe(tier);
    }
  });
});

describe('ApplicationStatusSchema', () => {
  it('accepts each known status', () => {
    for (const status of ['submitted', 'in_review', 'approved', 'rejected', 'withdrawn']) {
      expect(ApplicationStatusSchema.parse(status)).toBe(status);
    }
  });
});

describe('BackgroundCheckStatusSchema', () => {
  it('accepts each known status', () => {
    for (const status of [
      'pending',
      'processing',
      'clear',
      'consider',
      'suspended',
      'engaged',
      'dispute',
      'canceled',
      'failed',
    ]) {
      expect(BackgroundCheckStatusSchema.parse(status)).toBe(status);
    }
  });
});

describe('ProviderApplicantSchema', () => {
  it('accepts a well-formed applicant', () => {
    const parsed = ProviderApplicantSchema.parse(VALID_APPLICANT);
    expect(parsed.firstName).toBe('Sam');
  });

  it('rejects an email that is not RFC-compliant', () => {
    expect(() =>
      ProviderApplicantSchema.parse({ ...VALID_APPLICANT, email: 'not-an-email' }),
    ).toThrow();
  });

  it('rejects a dob that is not ISO YYYY-MM-DD', () => {
    expect(() =>
      ProviderApplicantSchema.parse({ ...VALID_APPLICANT, dob: '05/12/1980' }),
    ).toThrow();
  });

  it('rejects an ssnLast4 that is not exactly 4 digits', () => {
    expect(() => ProviderApplicantSchema.parse({ ...VALID_APPLICANT, ssnLast4: '12' })).toThrow();
    expect(() =>
      ProviderApplicantSchema.parse({ ...VALID_APPLICANT, ssnLast4: '1234a' }),
    ).toThrow();
  });

  it('rejects a zipcode that is not 5 digits', () => {
    expect(() => ProviderApplicantSchema.parse({ ...VALID_APPLICANT, zipcode: '1002' })).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => ProviderApplicantSchema.parse({ ...VALID_APPLICANT, surprise: 'x' })).toThrow();
  });
});

describe('SubmitProviderApplicationRequestSchema', () => {
  it('accepts a well-formed request', () => {
    const parsed = SubmitProviderApplicationRequestSchema.parse({
      profile: VALID_PROFILE,
      applicant: VALID_APPLICANT,
      applicantNotes: 'I worked at Daniel for six years.',
    });
    expect(parsed.profile.displayName).toBe('Chef Sam');
    expect(parsed.applicant.lastName).toBe('Cook');
    expect(parsed.applicantNotes).toBe('I worked at Daniel for six years.');
  });

  it('rejects an empty displayName', () => {
    expect(() =>
      SubmitProviderApplicationRequestSchema.parse({
        profile: { ...VALID_PROFILE, displayName: '' },
        applicant: VALID_APPLICANT,
      }),
    ).toThrow();
  });

  it('rejects unknown top-level fields', () => {
    expect(() =>
      SubmitProviderApplicationRequestSchema.parse({
        profile: VALID_PROFILE,
        applicant: VALID_APPLICANT,
        extra: 'x',
      }),
    ).toThrow();
  });

  it('rejects an applicantNotes longer than the contract cap', () => {
    expect(() =>
      SubmitProviderApplicationRequestSchema.parse({
        profile: VALID_PROFILE,
        applicant: VALID_APPLICANT,
        applicantNotes: 'x'.repeat(2001),
      }),
    ).toThrow();
  });
});

describe('ProviderRecordSchema', () => {
  it('accepts a well-formed record', () => {
    expect(ProviderRecordSchema.parse(VALID_PROVIDER).id).toBe('prov_abc');
  });
  it('rejects a non-ISO createdAt', () => {
    expect(() => ProviderRecordSchema.parse({ ...VALID_PROVIDER, createdAt: 'not-iso' })).toThrow();
  });
});

describe('ProviderApplicationRecordSchema', () => {
  it('accepts a well-formed record', () => {
    expect(ProviderApplicationRecordSchema.parse(VALID_APPLICATION).id).toBe('app_abc');
  });
  it('allows null reviewedAt / withdrawnAt', () => {
    const parsed = ProviderApplicationRecordSchema.parse(VALID_APPLICATION);
    expect(parsed.reviewedAt).toBeNull();
    expect(parsed.withdrawnAt).toBeNull();
  });
});

describe('ProviderBackgroundCheckRecordSchema', () => {
  it('accepts a well-formed record', () => {
    expect(ProviderBackgroundCheckRecordSchema.parse(VALID_BG_CHECK).id).toBe('bg_abc');
  });
  it('allows null checkrReportId', () => {
    const parsed = ProviderBackgroundCheckRecordSchema.parse({
      ...VALID_BG_CHECK,
      checkrReportId: null,
    });
    expect(parsed.checkrReportId).toBeNull();
  });
});

describe('SubmitProviderApplicationResponseSchema', () => {
  it('accepts a full nested response', () => {
    const parsed = SubmitProviderApplicationResponseSchema.parse({
      provider: VALID_PROVIDER,
      application: VALID_APPLICATION,
      backgroundCheck: VALID_BG_CHECK,
    });
    expect(parsed.provider.id).toBe('prov_abc');
    expect(parsed.application.id).toBe('app_abc');
    expect(parsed.backgroundCheck.id).toBe('bg_abc');
  });
});

describe('ProviderApplicationStatusResponseSchema', () => {
  it('accepts an all-null response', () => {
    const parsed = ProviderApplicationStatusResponseSchema.parse({
      provider: null,
      application: null,
      backgroundCheck: null,
    });
    expect(parsed.provider).toBeNull();
  });

  it('accepts a fully-populated response', () => {
    const parsed = ProviderApplicationStatusResponseSchema.parse({
      provider: VALID_PROVIDER,
      application: VALID_APPLICATION,
      backgroundCheck: VALID_BG_CHECK,
    });
    expect(parsed.provider?.id).toBe('prov_abc');
  });
});

describe('ProviderBackgroundCheckInternalWebhookEventSchema', () => {
  it('accepts a well-formed internal-dispatch payload', () => {
    const parsed = ProviderBackgroundCheckInternalWebhookEventSchema.parse({
      eventId: 'evt_abc',
      eventType: 'report.completed',
      eventCreatedSeconds: 1_700_000_000,
      report: { id: 'rep_abc', candidateId: 'cand_abc', status: 'clear' },
      rawPayload: '{"id":"rep_abc","status":"clear"}',
    });
    expect(parsed.report.id).toBe('rep_abc');
  });

  it('rejects an oversized rawPayload', () => {
    expect(() =>
      ProviderBackgroundCheckInternalWebhookEventSchema.parse({
        eventId: 'evt_abc',
        eventType: 'report.completed',
        eventCreatedSeconds: 1_700_000_000,
        report: { id: 'rep_abc', candidateId: 'cand_abc', status: 'clear' },
        rawPayload: 'x'.repeat(65_537),
      }),
    ).toThrow();
  });

  it('rejects negative eventCreatedSeconds', () => {
    expect(() =>
      ProviderBackgroundCheckInternalWebhookEventSchema.parse({
        eventId: 'evt_abc',
        eventType: 'report.completed',
        eventCreatedSeconds: -1,
        report: { id: 'rep_abc', candidateId: 'cand_abc', status: 'clear' },
        rawPayload: '{}',
      }),
    ).toThrow();
  });
});

describe('ProviderBackgroundCheckInternalWebhookResponseSchema', () => {
  it('accepts each known outcome', () => {
    for (const outcome of ['applied', 'replayed', 'report_mismatch']) {
      const parsed = ProviderBackgroundCheckInternalWebhookResponseSchema.parse({
        outcome,
        record: null,
      });
      expect(parsed.outcome).toBe(outcome);
    }
  });

  it('rejects an unknown outcome', () => {
    expect(() =>
      ProviderBackgroundCheckInternalWebhookResponseSchema.parse({
        outcome: 'weird',
        record: null,
      }),
    ).toThrow();
  });
});
