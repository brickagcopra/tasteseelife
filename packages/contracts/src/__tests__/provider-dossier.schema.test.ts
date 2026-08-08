import { describe, expect, it } from 'vitest';

import {
  ProviderDossierBackgroundCheckSchema,
  ProviderDossierCoreSchema,
  ProviderDossierResponseSchema,
} from '../http/provider-dossier.schema';

/**
 * Contract tests for the admin provider dossier (TS-305a).
 *
 * The assertions that matter most in this file are the two exclusions:
 *
 *   1. The background-check projection must NOT carry Checkr's candidate /
 *      report identifiers. Those are handles into a consumer-reporting
 *      system whose contents sit behind them; a review committee needs the
 *      verdict, not the file. `.strict()` turns a future re-widening into a
 *      failing test rather than a silent leak onto a screenshotted page.
 *
 *   2. The dossier must NOT carry `rating` / `completionRate` /
 *      `responseTimeP50` fields. Neither is measured anywhere on this
 *      platform (TS-305d / TS-305e), and a nullable field would read as "no
 *      data for this provider" when the truth is "not measured". The absence
 *      is the contract.
 */

const CORE = {
  id: 'prov_1',
  userId: 'usr_1',
  status: 'active',
  tier: 'certified',
  displayName: 'Chef Amara',
  headline: 'Slow-cooked comfort food',
  bio: null,
  profilePhotoKey: null,
  videoIntroKey: null,
  timeZone: 'America/New_York',
  dementiaSensitive: true,
  languages: ['english'],
  cuisines: ['west-african'],
  dietaryExpertise: ['low-sodium'],
  createdAt: '2026-01-04T10:00:00.000Z',
  updatedAt: '2026-05-19T10:00:00.000Z',
  deletedAt: null,
} as const;

const CERTIFICATION = {
  id: 'pcert_1',
  providerId: 'prov_1',
  certification: { id: 'cert_1', code: 'food-handler', name: 'Food Handler' },
  issuedAt: '2026-01-05T10:00:00.000Z',
  expiresAt: '2027-01-05T10:00:00.000Z',
  revokedAt: null,
  revocationReason: null,
  notes: null,
  active: true,
  createdAt: '2026-01-05T10:00:00.000Z',
  updatedAt: '2026-01-05T10:00:00.000Z',
} as const;

const TIER_TRANSITION = {
  id: 'pth_1',
  providerId: 'prov_1',
  fromTier: 'basic',
  toTier: 'certified',
  reason: 'auto_evaluation',
  triggeredByUserId: 'usr_ops',
  notes: null,
  occurredAt: '2026-01-05T10:00:01.000Z',
} as const;

const BACKGROUND_CHECK = {
  id: 'pbc_1',
  status: 'clear',
  completedAt: '2026-01-04T18:00:00.000Z',
  createdAt: '2026-01-04T10:00:00.000Z',
  updatedAt: '2026-01-04T18:00:00.000Z',
} as const;

const METRICS = {
  lifetime: { state: 'no_activity' },
  recent: { state: 'no_activity' },
  windowDays: 90,
  firstObservedAt: null,
  lastObservedAt: null,
  computedAt: '2026-07-26T12:00:00.000Z',
} as const;

const DOSSIER = {
  provider: CORE,
  certifications: [CERTIFICATION],
  tierHistory: [TIER_TRANSITION],
  backgroundCheck: BACKGROUND_CHECK,
  metrics: METRICS,
  generatedAt: '2026-07-26T12:00:00.000Z',
} as const;

describe('ProviderDossierBackgroundCheckSchema', () => {
  it('accepts a verdict-only projection', () => {
    const parsed = ProviderDossierBackgroundCheckSchema.parse(BACKGROUND_CHECK);
    expect(parsed.status).toBe('clear');
    expect(parsed.completedAt).toBe('2026-01-04T18:00:00.000Z');
  });

  it('accepts an in-flight check whose completedAt is still null', () => {
    const parsed = ProviderDossierBackgroundCheckSchema.parse({
      ...BACKGROUND_CHECK,
      status: 'pending',
      completedAt: null,
    });
    expect(parsed.completedAt).toBeNull();
  });

  it.each(['checkrCandidateId', 'checkrReportId', 'payloadCiphertext', 'lastEventId'])(
    'REJECTS the consumer-report handle %s',
    (field) => {
      const result = ProviderDossierBackgroundCheckSchema.safeParse({
        ...BACKGROUND_CHECK,
        [field]: 'leaked',
      });
      expect(result.success).toBe(false);
    },
  );

  it('carries exactly the five verdict fields and no more', () => {
    expect(Object.keys(ProviderDossierBackgroundCheckSchema.shape).sort()).toEqual([
      'completedAt',
      'createdAt',
      'id',
      'status',
      'updatedAt',
    ]);
  });

  it('accepts every background-check status the provider schema can hold', () => {
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
      expect(
        ProviderDossierBackgroundCheckSchema.safeParse({ ...BACKGROUND_CHECK, status }).success,
      ).toBe(true);
    }
  });
});

describe('ProviderDossierCoreSchema', () => {
  it('accepts the public profile fields plus the two admin-only columns', () => {
    const parsed = ProviderDossierCoreSchema.parse(CORE);
    expect(parsed.userId).toBe('usr_1');
    expect(parsed.deletedAt).toBeNull();
  });

  it('accepts an ARCHIVED provider — the dossier serves soft-deleted rows on purpose', () => {
    const parsed = ProviderDossierCoreSchema.parse({
      ...CORE,
      status: 'archived',
      deletedAt: '2026-03-03T09:00:00.000Z',
    });
    expect(parsed.deletedAt).toBe('2026-03-03T09:00:00.000Z');
  });

  it('requires userId — the console cross-links to the identity user', () => {
    const { userId: _dropped, ...withoutUserId } = CORE;
    expect(ProviderDossierCoreSchema.safeParse(withoutUserId).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(ProviderDossierCoreSchema.safeParse({ ...CORE, ssn: '000-00-0000' }).success).toBe(
      false,
    );
  });
});

describe('ProviderDossierResponseSchema', () => {
  it('accepts a fully-populated dossier', () => {
    const parsed = ProviderDossierResponseSchema.parse(DOSSIER);
    expect(parsed.certifications).toHaveLength(1);
    expect(parsed.tierHistory).toHaveLength(1);
    expect(parsed.backgroundCheck?.status).toBe('clear');
  });

  it('accepts a null background check — "no check on file" is itself a finding', () => {
    const parsed = ProviderDossierResponseSchema.parse({ ...DOSSIER, backgroundCheck: null });
    expect(parsed.backgroundCheck).toBeNull();
  });

  it('accepts a brand-new provider with empty history arrays', () => {
    const parsed = ProviderDossierResponseSchema.parse({
      ...DOSSIER,
      certifications: [],
      tierHistory: [],
      backgroundCheck: null,
    });
    expect(parsed.certifications).toEqual([]);
    expect(parsed.tierHistory).toEqual([]);
  });

  it('carries a REVOKED certification — the dossier is full history, not active-only', () => {
    const parsed = ProviderDossierResponseSchema.parse({
      ...DOSSIER,
      certifications: [
        {
          ...CERTIFICATION,
          revokedAt: '2026-06-01T10:00:00.000Z',
          revocationReason: 'Credential lapsed at the issuing body.',
          active: false,
        },
      ],
    });
    expect(parsed.certifications[0]?.active).toBe(false);
    expect(parsed.certifications[0]?.revocationReason).toBe(
      'Credential lapsed at the issuing body.',
    );
  });

  it.each(['rating', 'ratingAvg', 'completionRate', 'responseTimeP50'])(
    'REJECTS a top-level %s — ratings are still unmeasured (TS-305e), and the performance figures live under `metrics` with their window and their state, never as a bare number',
    (field) => {
      expect(ProviderDossierResponseSchema.safeParse({ ...DOSSIER, [field]: 0 }).success).toBe(
        false,
      );
    },
  );

  it('rejects an incidents section — incidents are composed by the gateway, not joined here', () => {
    expect(ProviderDossierResponseSchema.safeParse({ ...DOSSIER, incidents: [] }).success).toBe(
      false,
    );
  });

  it('requires generatedAt to be an ISO-8601 instant', () => {
    expect(
      ProviderDossierResponseSchema.safeParse({ ...DOSSIER, generatedAt: '2026-07-26' }).success,
    ).toBe(false);
  });
});
