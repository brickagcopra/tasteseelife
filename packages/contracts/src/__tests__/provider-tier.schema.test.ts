import { describe, expect, it } from 'vitest';

import {
  CERTIFICATION_REVOCATION_REASON_MAX_LENGTH,
  CertificationSchema,
  CertificationsListResponseSchema,
  GrantProviderCertificationRequestSchema,
  ProviderCertificationRecordSchema,
  ProviderCertificationResponseSchema,
  ProviderCertificationsListResponseSchema,
  ProviderProfileResponseSchema,
  ProviderTierHistoryRecordSchema,
  ProviderTierHistoryResponseSchema,
  RevokeProviderCertificationRequestSchema,
  TIER_OVERRIDE_NOTES_MAX_LENGTH,
  TierEvaluationResponseSchema,
  TierOverrideRequestSchema,
  TierTransitionReasonSchema,
} from '../http/provider-tier.schema';

const NOW = '2026-05-11T12:00:00.000Z';

const VALID_CERTIFICATION = {
  id: 'cert_abc',
  code: 'ccc',
  name: 'Certified Culinary Companion',
  description: 'Taste & See Cooking Academy core certification.',
  issuer: 'Taste & See Cooking Academy',
  defaultValidityMonths: 24,
  sortPosition: 0,
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const VALID_PROVIDER_CERTIFICATION = {
  id: 'pc_abc',
  providerId: 'prov_abc',
  certification: {
    id: 'cert_abc',
    code: 'ccc',
    name: 'Certified Culinary Companion',
  },
  issuedAt: NOW,
  expiresAt: '2028-05-11T12:00:00.000Z',
  revokedAt: null,
  revocationReason: null,
  notes: null,
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const VALID_PROVIDER = {
  id: 'prov_abc',
  status: 'active' as const,
  tier: 'certified' as const,
  displayName: 'Chef Sam',
  headline: null,
  bio: null,
  profilePhotoKey: null,
  videoIntroKey: null,
  timeZone: 'America/New_York',
  createdAt: NOW,
  updatedAt: NOW,
};

const VALID_TIER_HISTORY = {
  id: 'th_abc',
  providerId: 'prov_abc',
  fromTier: 'basic' as const,
  toTier: 'certified' as const,
  reason: 'auto_evaluation' as const,
  triggeredByUserId: 'user_ops',
  notes: null,
  occurredAt: NOW,
} as const;

describe('CertificationSchema', () => {
  it('accepts a valid catalog row', () => {
    expect(CertificationSchema.parse(VALID_CERTIFICATION)).toEqual(VALID_CERTIFICATION);
  });

  it('accepts a null defaultValidityMonths (no expiry)', () => {
    const cert = { ...VALID_CERTIFICATION, defaultValidityMonths: null };
    expect(CertificationSchema.parse(cert).defaultValidityMonths).toBeNull();
  });

  it('rejects a zero defaultValidityMonths', () => {
    expect(() =>
      CertificationSchema.parse({ ...VALID_CERTIFICATION, defaultValidityMonths: 0 }),
    ).toThrow();
  });

  it('rejects a non-integer defaultValidityMonths', () => {
    expect(() =>
      CertificationSchema.parse({ ...VALID_CERTIFICATION, defaultValidityMonths: 12.5 }),
    ).toThrow();
  });

  it('rejects unknown fields under strict mode', () => {
    expect(() => CertificationSchema.parse({ ...VALID_CERTIFICATION, extra: 'nope' })).toThrow();
  });

  it('rejects an empty code', () => {
    expect(() => CertificationSchema.parse({ ...VALID_CERTIFICATION, code: '' })).toThrow();
  });

  it('rejects an over-long name', () => {
    expect(() =>
      CertificationSchema.parse({ ...VALID_CERTIFICATION, name: 'x'.repeat(121) }),
    ).toThrow();
  });

  it('rejects a negative sortPosition', () => {
    expect(() => CertificationSchema.parse({ ...VALID_CERTIFICATION, sortPosition: -1 })).toThrow();
  });
});

describe('CertificationsListResponseSchema', () => {
  it('round-trips an empty list', () => {
    const parsed = CertificationsListResponseSchema.parse({ certifications: [] });
    expect(parsed.certifications).toEqual([]);
  });

  it('round-trips a populated list', () => {
    const parsed = CertificationsListResponseSchema.parse({
      certifications: [VALID_CERTIFICATION],
    });
    expect(parsed.certifications).toHaveLength(1);
  });

  it('rejects unknown wrapper keys', () => {
    expect(() =>
      CertificationsListResponseSchema.parse({
        certifications: [],
        extra: true,
      }),
    ).toThrow();
  });
});

describe('ProviderCertificationRecordSchema', () => {
  it('accepts an active record', () => {
    expect(ProviderCertificationRecordSchema.parse(VALID_PROVIDER_CERTIFICATION)).toEqual(
      VALID_PROVIDER_CERTIFICATION,
    );
  });

  it('accepts a revoked record', () => {
    const revoked = {
      ...VALID_PROVIDER_CERTIFICATION,
      revokedAt: NOW,
      revocationReason: 'Performance complaint upheld.',
      active: false,
    };
    expect(ProviderCertificationRecordSchema.parse(revoked).active).toBe(false);
  });

  it('accepts a non-expiring record (expiresAt null)', () => {
    const noExpiry = { ...VALID_PROVIDER_CERTIFICATION, expiresAt: null };
    expect(ProviderCertificationRecordSchema.parse(noExpiry).expiresAt).toBeNull();
  });

  it('rejects an over-long revocation reason', () => {
    const bad = {
      ...VALID_PROVIDER_CERTIFICATION,
      revokedAt: NOW,
      revocationReason: 'x'.repeat(CERTIFICATION_REVOCATION_REASON_MAX_LENGTH + 1),
      active: false,
    };
    expect(() => ProviderCertificationRecordSchema.parse(bad)).toThrow();
  });

  it('rejects unknown nested certification keys', () => {
    const bad = {
      ...VALID_PROVIDER_CERTIFICATION,
      certification: {
        ...VALID_PROVIDER_CERTIFICATION.certification,
        slug: 'extra',
      },
    };
    expect(() => ProviderCertificationRecordSchema.parse(bad)).toThrow();
  });
});

describe('ProviderCertificationsListResponseSchema', () => {
  it('round-trips an empty list', () => {
    expect(
      ProviderCertificationsListResponseSchema.parse({ certifications: [] }).certifications,
    ).toEqual([]);
  });

  it('round-trips a populated list', () => {
    const parsed = ProviderCertificationsListResponseSchema.parse({
      certifications: [VALID_PROVIDER_CERTIFICATION],
    });
    expect(parsed.certifications).toHaveLength(1);
  });
});

describe('GrantProviderCertificationRequestSchema', () => {
  it('accepts the minimal valid body', () => {
    expect(GrantProviderCertificationRequestSchema.parse({ certificationCode: 'ccc' })).toEqual({
      certificationCode: 'ccc',
    });
  });

  it('accepts the fully-populated body', () => {
    const full = {
      certificationCode: 'ccc',
      issuedAt: NOW,
      expiresAt: '2028-05-11T12:00:00.000Z',
      notes: 'Granted on completion of academy track.',
    };
    expect(GrantProviderCertificationRequestSchema.parse(full)).toEqual(full);
  });

  it('accepts an explicit null expiresAt (no expiry override)', () => {
    const parsed = GrantProviderCertificationRequestSchema.parse({
      certificationCode: 'ccc',
      expiresAt: null,
    });
    expect(parsed.expiresAt).toBeNull();
  });

  it('rejects an empty certificationCode', () => {
    expect(() =>
      GrantProviderCertificationRequestSchema.parse({ certificationCode: '' }),
    ).toThrow();
  });

  it('rejects unknown fields under strict mode', () => {
    expect(() =>
      GrantProviderCertificationRequestSchema.parse({
        certificationCode: 'ccc',
        bogus: 1,
      }),
    ).toThrow();
  });

  it('rejects a malformed datetime', () => {
    expect(() =>
      GrantProviderCertificationRequestSchema.parse({
        certificationCode: 'ccc',
        issuedAt: '2026-05-11',
      }),
    ).toThrow();
  });
});

describe('ProviderCertificationResponseSchema', () => {
  it('round-trips a wrapped record', () => {
    expect(
      ProviderCertificationResponseSchema.parse({
        certification: VALID_PROVIDER_CERTIFICATION,
      }),
    ).toEqual({ certification: VALID_PROVIDER_CERTIFICATION });
  });
});

describe('RevokeProviderCertificationRequestSchema', () => {
  it('accepts a valid reason', () => {
    expect(
      RevokeProviderCertificationRequestSchema.parse({
        reason: 'Failed re-certification assessment.',
      }),
    ).toEqual({ reason: 'Failed re-certification assessment.' });
  });

  it('rejects an empty reason', () => {
    expect(() => RevokeProviderCertificationRequestSchema.parse({ reason: '' })).toThrow();
  });

  it('rejects an over-long reason', () => {
    expect(() =>
      RevokeProviderCertificationRequestSchema.parse({
        reason: 'x'.repeat(CERTIFICATION_REVOCATION_REASON_MAX_LENGTH + 1),
      }),
    ).toThrow();
  });
});

describe('TierTransitionReasonSchema', () => {
  it('accepts both supported reasons', () => {
    expect(TierTransitionReasonSchema.parse('auto_evaluation')).toBe('auto_evaluation');
    expect(TierTransitionReasonSchema.parse('admin_override')).toBe('admin_override');
  });

  it('rejects unrecognised reasons', () => {
    expect(() => TierTransitionReasonSchema.parse('certification_revoked')).toThrow();
  });
});

describe('ProviderTierHistoryRecordSchema', () => {
  it('accepts a typical promotion', () => {
    expect(ProviderTierHistoryRecordSchema.parse(VALID_TIER_HISTORY)).toEqual(VALID_TIER_HISTORY);
  });

  it('accepts a null fromTier (initial set)', () => {
    expect(
      ProviderTierHistoryRecordSchema.parse({
        ...VALID_TIER_HISTORY,
        fromTier: null,
      }).fromTier,
    ).toBeNull();
  });

  it('rejects a malformed reason', () => {
    expect(() =>
      ProviderTierHistoryRecordSchema.parse({
        ...VALID_TIER_HISTORY,
        reason: 'bogus',
      }),
    ).toThrow();
  });
});

describe('ProviderTierHistoryResponseSchema', () => {
  it('round-trips an empty history', () => {
    expect(ProviderTierHistoryResponseSchema.parse({ history: [] }).history).toEqual([]);
  });

  it('round-trips a populated history', () => {
    expect(
      ProviderTierHistoryResponseSchema.parse({ history: [VALID_TIER_HISTORY] }).history,
    ).toHaveLength(1);
  });
});

describe('TierEvaluationResponseSchema', () => {
  it('round-trips an applied evaluation', () => {
    const body = {
      provider: VALID_PROVIDER,
      previousTier: 'basic' as const,
      nextTier: 'certified' as const,
      applied: true,
      history: VALID_TIER_HISTORY,
    };
    expect(TierEvaluationResponseSchema.parse(body)).toEqual(body);
  });

  it('round-trips a no-op evaluation', () => {
    const body = {
      provider: VALID_PROVIDER,
      previousTier: 'certified' as const,
      nextTier: 'certified' as const,
      applied: false,
      history: null,
    };
    expect(TierEvaluationResponseSchema.parse(body).applied).toBe(false);
  });
});

describe('TierOverrideRequestSchema', () => {
  it('accepts a valid body', () => {
    expect(
      TierOverrideRequestSchema.parse({
        targetTier: 'basic',
        notes: 'Demoting pending complaint review.',
      }),
    ).toEqual({
      targetTier: 'basic',
      notes: 'Demoting pending complaint review.',
    });
  });

  it('rejects an empty notes field', () => {
    expect(() => TierOverrideRequestSchema.parse({ targetTier: 'basic', notes: '' })).toThrow();
  });

  it('rejects an over-long notes field', () => {
    expect(() =>
      TierOverrideRequestSchema.parse({
        targetTier: 'basic',
        notes: 'x'.repeat(TIER_OVERRIDE_NOTES_MAX_LENGTH + 1),
      }),
    ).toThrow();
  });

  it('rejects an unrecognised targetTier', () => {
    expect(() =>
      TierOverrideRequestSchema.parse({
        targetTier: 'platinum',
        notes: 'nope',
      }),
    ).toThrow();
  });
});

describe('ProviderProfileResponseSchema', () => {
  it('accepts a populated profile with active certs', () => {
    const body = {
      provider: VALID_PROVIDER,
      activeCertifications: [VALID_PROVIDER_CERTIFICATION],
    };
    expect(ProviderProfileResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts a null provider (user without one)', () => {
    expect(
      ProviderProfileResponseSchema.parse({
        provider: null,
        activeCertifications: [],
      }).provider,
    ).toBeNull();
  });
});
