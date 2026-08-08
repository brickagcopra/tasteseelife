import { describe, expect, it } from 'vitest';

import {
  ACADEMY_CERTIFICATION_RENEWAL_HORIZON_DAYS_DEFAULT,
  ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CATEGORY,
  ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CHANNEL,
  ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CODE,
  ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_LOCALE,
  ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_VARIABLE_NAMES,
  ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_VARIABLES,
  ACADEMY_CERTIFICATION_RENEWAL_THRESHOLD_DAYS,
  ACADEMY_CERTIFICATION_RENEWALS_HORIZON_DAYS_MAX,
  ACADEMY_CERTIFICATION_RENEWALS_PAGE_LIMIT_DEFAULT,
  ACADEMY_CERTIFICATION_RENEWALS_PAGE_LIMIT_MAX,
  CertificationRenewalCandidateSchema,
  ExpireCertificationResponseSchema,
  InternalCertificationRenewalsQuerySchema,
  InternalCertificationRenewalsResponseSchema,
  resolveCertificationRenewalThreshold,
} from '../http/academy-certification-renewals.schema';

const TS = '2026-06-08T12:00:00.000Z';

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    certificationId: 'cert_1',
    studentUserId: 'student_1',
    holderName: 'Jane Holder',
    courseId: 'course_1',
    courseTitle: 'Dementia-Sensitive Dining',
    track: 'dementia_sensitive',
    issuedAt: TS,
    expiresAt: TS,
    ...overrides,
  };
}

describe('ACADEMY_CERTIFICATION_RENEWAL_THRESHOLD_DAYS', () => {
  it('is the descending 90/60/30/7 cadence (PRD §9.3)', () => {
    expect(ACADEMY_CERTIFICATION_RENEWAL_THRESHOLD_DAYS).toEqual([90, 60, 30, 7]);
  });

  it('exposes the largest milestone as the default horizon', () => {
    expect(ACADEMY_CERTIFICATION_RENEWAL_HORIZON_DAYS_DEFAULT).toBe(90);
  });
});

describe('resolveCertificationRenewalThreshold', () => {
  it('returns null beyond the reminder window (> 90 days)', () => {
    expect(resolveCertificationRenewalThreshold(91)).toBeNull();
    expect(resolveCertificationRenewalThreshold(120)).toBeNull();
  });

  it('returns null for a lapsed certification (<= 0 days)', () => {
    expect(resolveCertificationRenewalThreshold(0)).toBeNull();
    expect(resolveCertificationRenewalThreshold(-5)).toBeNull();
  });

  it('returns null for non-finite input', () => {
    expect(resolveCertificationRenewalThreshold(Number.NaN)).toBeNull();
    expect(resolveCertificationRenewalThreshold(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('maps each open interval to its nearest upcoming milestone', () => {
    // (60, 90] → 90
    expect(resolveCertificationRenewalThreshold(90)).toBe(90);
    expect(resolveCertificationRenewalThreshold(85)).toBe(90);
    expect(resolveCertificationRenewalThreshold(61)).toBe(90);
    // (30, 60] → 60
    expect(resolveCertificationRenewalThreshold(60)).toBe(60);
    expect(resolveCertificationRenewalThreshold(45)).toBe(60);
    expect(resolveCertificationRenewalThreshold(31)).toBe(60);
    // (7, 30] → 30
    expect(resolveCertificationRenewalThreshold(30)).toBe(30);
    expect(resolveCertificationRenewalThreshold(8)).toBe(30);
    // (0, 7] → 7
    expect(resolveCertificationRenewalThreshold(7)).toBe(7);
    expect(resolveCertificationRenewalThreshold(1)).toBe(7);
  });

  it('treats the boundary day as belonging to the lower (nearer) milestone', () => {
    // d === 60 belongs to bucket 60, not 90 (smallest threshold >= d)
    expect(resolveCertificationRenewalThreshold(60)).toBe(60);
    expect(resolveCertificationRenewalThreshold(30)).toBe(30);
    expect(resolveCertificationRenewalThreshold(7)).toBe(7);
  });
});

describe('CertificationRenewalCandidateSchema', () => {
  it('accepts a well-formed candidate', () => {
    expect(CertificationRenewalCandidateSchema.parse(candidate())).toMatchObject({
      certificationId: 'cert_1',
      track: 'dementia_sensitive',
    });
  });

  it('accepts a null holderName (the cert snapshot may be absent)', () => {
    expect(
      CertificationRenewalCandidateSchema.parse(candidate({ holderName: null })).holderName,
    ).toBeNull();
  });

  it('rejects a null expiresAt (the service only returns expiry-bearing rows)', () => {
    expect(() =>
      CertificationRenewalCandidateSchema.parse(candidate({ expiresAt: null })),
    ).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() =>
      CertificationRenewalCandidateSchema.parse(candidate({ verificationToken: 'tok' })),
    ).toThrow();
  });

  it('rejects an unknown track', () => {
    expect(() => CertificationRenewalCandidateSchema.parse(candidate({ track: 'nope' }))).toThrow();
  });
});

describe('InternalCertificationRenewalsQuerySchema', () => {
  it('defaults limit + horizonDays, leaves cursor undefined', () => {
    const parsed = InternalCertificationRenewalsQuerySchema.parse({});
    expect(parsed.limit).toBe(ACADEMY_CERTIFICATION_RENEWALS_PAGE_LIMIT_DEFAULT);
    expect(parsed.horizonDays).toBe(ACADEMY_CERTIFICATION_RENEWAL_HORIZON_DAYS_DEFAULT);
    expect(parsed.cursor).toBeUndefined();
  });

  it('coerces numeric strings (query params arrive as strings)', () => {
    const parsed = InternalCertificationRenewalsQuerySchema.parse({
      limit: '50',
      horizonDays: '30',
    });
    expect(parsed.limit).toBe(50);
    expect(parsed.horizonDays).toBe(30);
  });

  it('rejects a limit over the cap', () => {
    expect(() =>
      InternalCertificationRenewalsQuerySchema.parse({
        limit: String(ACADEMY_CERTIFICATION_RENEWALS_PAGE_LIMIT_MAX + 1),
      }),
    ).toThrow();
  });

  it('rejects a horizon over the cap', () => {
    expect(() =>
      InternalCertificationRenewalsQuerySchema.parse({
        horizonDays: String(ACADEMY_CERTIFICATION_RENEWALS_HORIZON_DAYS_MAX + 1),
      }),
    ).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => InternalCertificationRenewalsQuerySchema.parse({ status: 'active' })).toThrow();
  });
});

describe('InternalCertificationRenewalsResponseSchema', () => {
  it('accepts a page with a cursor', () => {
    const parsed = InternalCertificationRenewalsResponseSchema.parse({
      certifications: [candidate()],
      nextCursor: 'cert_1',
    });
    expect(parsed.certifications).toHaveLength(1);
    expect(parsed.nextCursor).toBe('cert_1');
  });

  it('accepts an empty final page (null cursor)', () => {
    expect(
      InternalCertificationRenewalsResponseSchema.parse({ certifications: [], nextCursor: null }),
    ).toEqual({ certifications: [], nextCursor: null });
  });
});

describe('ExpireCertificationResponseSchema', () => {
  it('accepts a changed expiry', () => {
    expect(
      ExpireCertificationResponseSchema.parse({
        certificationId: 'cert_1',
        status: 'expired',
        changed: true,
      }),
    ).toMatchObject({ status: 'expired', changed: true });
  });

  it('accepts an idempotent no-op', () => {
    expect(
      ExpireCertificationResponseSchema.parse({
        certificationId: 'cert_1',
        status: 'expired',
        changed: false,
      }),
    ).toMatchObject({ changed: false });
  });

  it('rejects an unknown status', () => {
    expect(() =>
      ExpireCertificationResponseSchema.parse({
        certificationId: 'cert_1',
        status: 'lapsed',
        changed: true,
      }),
    ).toThrow();
  });
});

describe('certification-renewal template contract', () => {
  it('pins the template identity', () => {
    expect(ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CODE).toBe('academy-certification-renewal');
    expect(ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_LOCALE).toBe('en-US');
    expect(ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CHANNEL).toBe('email');
    expect(ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CATEGORY).toBe('transactional');
  });

  it('keeps the variable list + the name tuple in lock-step', () => {
    const declaredNames = ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_VARIABLES.map((v) => v.name);
    expect(declaredNames).toEqual([...ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_VARIABLE_NAMES]);
  });

  it('marks every variable required', () => {
    expect(ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_VARIABLES.every((v) => v.required)).toBe(true);
  });
});
