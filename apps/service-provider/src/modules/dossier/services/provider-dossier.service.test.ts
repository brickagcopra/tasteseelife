import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import type {
  ProviderCertificationsService,
  ProviderCertificationWithCatalog,
} from '../../certifications/services/provider-certifications.service';
import type {
  ProviderTierHistoryRow,
  TierPromotionService,
} from '../../certifications/services/tier-promotion.service';
import type {
  ProviderProfileService,
  ProviderProfileSnapshot,
} from '../../profile/services/provider-profile.service';

import { ProviderMetricsService } from '../../metrics/services/provider-metrics.service';
import { ProviderDossierService } from './provider-dossier.service';

/**
 * Unit tests for the dossier assembly (TS-305a).
 *
 * The load-bearing assertions here:
 *   - the certification read asks for the FULL history, not active-only
 *     (a revoked credential is the row a review committee came for);
 *   - the background-check query projects the verdict columns ONLY —
 *     the Checkr handles and the encrypted payload must not be
 *     selectable from this path;
 *   - an ARCHIVED provider is served, not 404'd;
 *   - one clock drives every certification's `active` computation.
 */

const NOW = new Date('2026-07-26T12:00:00.000Z');

const SNAPSHOT: ProviderProfileSnapshot = {
  row: {
    id: 'prov_1',
    userId: 'usr_1',
    status: 'active',
    tier: 'certified',
    displayName: 'Chef Amara',
    headline: null,
    bio: null,
    profilePhotoKey: null,
    videoIntroKey: null,
    timeZone: 'America/New_York',
    dementiaSensitive: false,
    createdAt: new Date('2026-01-04T10:00:00.000Z'),
    updatedAt: new Date('2026-05-19T10:00:00.000Z'),
    deletedAt: null,
  },
  languages: ['english'],
  cuisines: [],
  dietaryExpertise: [],
};

function certRecord(
  overrides: Partial<ProviderCertificationWithCatalog['row']> = {},
): ProviderCertificationWithCatalog {
  return {
    row: {
      id: 'pcert_1',
      providerId: 'prov_1',
      certificationId: 'cert_1',
      issuedAt: new Date('2026-01-05T10:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
      revocationReason: null,
      issuerUserId: null,
      revokerUserId: null,
      notes: null,
      createdAt: new Date('2026-01-05T10:00:00.000Z'),
      updatedAt: new Date('2026-01-05T10:00:00.000Z'),
      ...overrides,
    },
    catalog: {
      id: 'cert_1',
      code: 'food-handler',
      name: 'Food Handler',
    },
  } as unknown as ProviderCertificationWithCatalog;
}

const TIER_ROW: ProviderTierHistoryRow = {
  id: 'pth_1',
  providerId: 'prov_1',
  fromTier: 'basic',
  toTier: 'certified',
  reason: 'auto_evaluation',
  triggeredByUserId: 'usr_ops',
  notes: null,
  occurredAt: new Date('2026-01-05T10:00:01.000Z'),
} as unknown as ProviderTierHistoryRow;

const BG_ROW = {
  id: 'pbc_1',
  status: 'clear' as const,
  completedAt: new Date('2026-01-04T18:00:00.000Z'),
  createdAt: new Date('2026-01-04T10:00:00.000Z'),
  updatedAt: new Date('2026-01-04T18:00:00.000Z'),
};

interface Harness {
  readonly service: ProviderDossierService;
  readonly capture: {
    listArgs?: readonly unknown[];
    bgFindArgs?: Record<string, unknown>;
    metricsNow?: Date;
  };
}

function makeHarness(options: {
  readonly snapshot?: ProviderProfileSnapshot | null;
  readonly certifications?: readonly ProviderCertificationWithCatalog[];
  readonly tierHistory?: readonly ProviderTierHistoryRow[];
  readonly backgroundCheck?: typeof BG_ROW | null;
}): Harness {
  const capture: Harness['capture'] = {};

  const prisma = {
    providerBackgroundCheck: {
      findFirst: async (args: Record<string, unknown>) => {
        capture.bgFindArgs = args;
        return options.backgroundCheck === undefined ? BG_ROW : options.backgroundCheck;
      },
    },
  } as unknown as PrismaService;

  const profile = {
    getProfile: async () => (options.snapshot === undefined ? SNAPSHOT : options.snapshot),
  } as unknown as ProviderProfileService;

  const certifications = {
    listForProvider: async (...args: readonly unknown[]) => {
      capture.listArgs = args;
      return options.certifications ?? [certRecord()];
    },
  } as unknown as ProviderCertificationsService;

  const tier = {
    getHistory: async () => options.tierHistory ?? [TIER_ROW],
  } as unknown as TierPromotionService;

  // TS-305d. Records the clock it was handed: the dossier must thread
  // its single `now` into every section, or a screenshotted review page
  // can disagree with itself across midnight.
  const metrics = {
    getMetrics: async (_providerId: string, now: Date) => {
      capture.metricsNow = now;
      return {
        lifetime: { state: 'no_activity' as const },
        recent: { state: 'no_activity' as const },
        windowDays: 90,
        firstObservedAt: null,
        lastObservedAt: null,
        computedAt: now.toISOString(),
      };
    },
  } as unknown as ProviderMetricsService;

  return {
    service: new ProviderDossierService(prisma, profile, certifications, tier, metrics),
    capture,
  };
}

describe('ProviderDossierService.getDossier', () => {
  it('threads its SINGLE clock into the metrics read (TS-305d) — the rolling window and a credential’s active flag must describe one instant', async () => {
    const { service, capture } = makeHarness({});
    await service.getDossier('prov_1', NOW);

    expect(capture.metricsNow).toBe(NOW);
  });

  it('carries a metrics section on every dossier, including a provider with no bookings', async () => {
    const { service } = makeHarness({});
    const dossier = await service.getDossier('prov_1', NOW);

    expect(dossier?.metrics.lifetime.state).toBe('no_activity');
    expect(dossier?.metrics.windowDays).toBe(90);
  });

  it('assembles all four sections', async () => {
    const { service } = makeHarness({});
    const dossier = await service.getDossier('prov_1', NOW);

    expect(dossier).not.toBeNull();
    expect(dossier?.profile.row.id).toBe('prov_1');
    expect(dossier?.certifications).toHaveLength(1);
    expect(dossier?.tierHistory).toHaveLength(1);
    expect(dossier?.backgroundCheck?.status).toBe('clear');
  });

  it('returns null when no provider row exists — the caller maps that to 404', async () => {
    const { service } = makeHarness({ snapshot: null });
    expect(await service.getDossier('prov_missing', NOW)).toBeNull();
  });

  it('returns null for an empty providerId without touching the database', async () => {
    const { service, capture } = makeHarness({});
    expect(await service.getDossier('', NOW)).toBeNull();
    expect(capture.bgFindArgs).toBeUndefined();
  });

  it('SERVES an archived provider — a review committee needs the archived row', async () => {
    const { service } = makeHarness({
      snapshot: {
        ...SNAPSHOT,
        row: {
          ...SNAPSHOT.row,
          status: 'archived',
          deletedAt: new Date('2026-03-03T09:00:00.000Z'),
        },
      },
    });

    const dossier = await service.getDossier('prov_1', NOW);
    expect(dossier?.profile.row.deletedAt).toEqual(new Date('2026-03-03T09:00:00.000Z'));
  });

  it('requests the FULL certification history, not the active-only set', async () => {
    const { service, capture } = makeHarness({});
    await service.getDossier('prov_1', NOW);

    expect(capture.listArgs?.[0]).toBe('prov_1');
    expect(capture.listArgs?.[1]).toEqual({ activeOnly: false, now: NOW });
  });

  it('includes a revoked certification, flagged inactive', async () => {
    const { service } = makeHarness({
      certifications: [
        certRecord({
          revokedAt: new Date('2026-06-01T10:00:00.000Z'),
          revocationReason: 'Credential lapsed at the issuing body.',
        }),
      ],
    });

    const dossier = await service.getDossier('prov_1', NOW);
    expect(dossier?.certifications[0]?.active).toBe(false);
    expect(dossier?.certifications[0]?.revocationReason).toBe(
      'Credential lapsed at the issuing body.',
    );
  });

  it('computes `active` against the SUPPLIED clock, not wall time', async () => {
    // Expires two hours after NOW. Evaluated at NOW it is active; a
    // dossier stamped a day later must report it expired. Threading the
    // clock is what makes both answers reproducible.
    const expiring = certRecord({ expiresAt: new Date('2026-07-26T14:00:00.000Z') });
    const { service } = makeHarness({ certifications: [expiring] });

    const atNow = await service.getDossier('prov_1', NOW);
    expect(atNow?.certifications[0]?.active).toBe(true);

    const nextDay = await service.getDossier('prov_1', new Date('2026-07-27T12:00:00.000Z'));
    expect(nextDay?.certifications[0]?.active).toBe(false);
  });

  it('projects the background check to its verdict fields only', async () => {
    const { service } = makeHarness({});
    const dossier = await service.getDossier('prov_1', NOW);

    expect(Object.keys(dossier?.backgroundCheck ?? {}).sort()).toEqual([
      'completedAt',
      'createdAt',
      'id',
      'status',
      'updatedAt',
    ]);
  });

  it('SELECTs only the verdict columns — the Checkr handles never leave the database', async () => {
    const { service, capture } = makeHarness({});
    await service.getDossier('prov_1', NOW);

    expect(capture.bgFindArgs?.['select']).toEqual({
      id: true,
      status: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
    });
    // Belt and braces: assert the forbidden columns are absent by name,
    // so a future `select` edit that adds one fails loudly here.
    const select = capture.bgFindArgs?.['select'] as Record<string, unknown>;
    for (const forbidden of [
      'checkrCandidateId',
      'checkrReportId',
      'lastEventId',
      'payloadCiphertext',
      'payloadIv',
      'payloadAuthTag',
      'payloadKeyVersion',
    ]) {
      expect(select[forbidden]).toBeUndefined();
    }
  });

  it('reads the MOST RECENT background check', async () => {
    const { service, capture } = makeHarness({});
    await service.getDossier('prov_1', NOW);

    expect(capture.bgFindArgs?.['where']).toEqual({ providerId: 'prov_1' });
    expect(capture.bgFindArgs?.['orderBy']).toEqual({ createdAt: 'desc' });
  });

  it('returns a null background check when the provider has none on file', async () => {
    const { service } = makeHarness({ backgroundCheck: null });
    const dossier = await service.getDossier('prov_1', NOW);
    expect(dossier?.backgroundCheck).toBeNull();
  });

  it('returns empty sections for a provider with no history', async () => {
    const { service } = makeHarness({
      certifications: [],
      tierHistory: [],
      backgroundCheck: null,
    });

    const dossier = await service.getDossier('prov_1', NOW);
    expect(dossier?.certifications).toEqual([]);
    expect(dossier?.tierHistory).toEqual([]);
  });
});
