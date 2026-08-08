import type { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogService } from '../../catalog/services/catalog.service';
import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';
import {
  TierGatingService,
  type HouseholdTierSnapshotRecord,
  type ProviderTierSnapshotRecord,
} from './tier-gating.service';

/**
 * TierGatingService unit suite (TS-064; PRD §5.1 / §5.2; CLAUDE.md §12).
 *
 * The service has two responsibilities:
 *   1. Persist read-side snapshot rows (household + provider tier).
 *   2. Evaluate the booking-create gate (Tier-3 Concierge households
 *      may only book Elite providers).
 *
 * Tests use an in-memory FakePrisma — mirrors the FakePrisma pattern in
 * `bookings.service.test.ts` — so we can deterministically assert every
 * decision shape and the upsert side effects.
 */

class FakePrisma {
  public householdRows = new Map<string, HouseholdTierSnapshotRecord>();
  public providerRows = new Map<string, ProviderTierSnapshotRecord>();

  householdTierSnapshot = {
    upsert: vi.fn(
      async (args: {
        where: { householdId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }): Promise<HouseholdTierSnapshotRecord> => {
        const existing = this.householdRows.get(args.where.householdId);
        if (existing) {
          const next: HouseholdTierSnapshotRecord = {
            ...existing,
            tier: (args.update['tier'] as HouseholdTierSnapshotRecord['tier']) ?? existing.tier,
            lastSyncedAt:
              (args.update['lastSyncedAt'] as Date | undefined) ?? existing.lastSyncedAt,
            sourceEventId:
              args.update['sourceEventId'] !== undefined
                ? (args.update['sourceEventId'] as string | null)
                : existing.sourceEventId,
            updatedAt: new Date('2026-05-14T12:05:00.000Z'),
          };
          this.householdRows.set(args.where.householdId, next);
          return next;
        }
        const row: HouseholdTierSnapshotRecord = {
          householdId: args.create['householdId'] as string,
          tier: args.create['tier'] as HouseholdTierSnapshotRecord['tier'],
          lastSyncedAt: args.create['lastSyncedAt'] as Date,
          sourceEventId: (args.create['sourceEventId'] as string | undefined) ?? null,
          createdAt: new Date('2026-05-14T12:00:00.000Z'),
          updatedAt: new Date('2026-05-14T12:00:00.000Z'),
        };
        this.householdRows.set(row.householdId, row);
        return row;
      },
    ),
    findUnique: vi.fn(
      async (args: {
        where: { householdId: string };
      }): Promise<HouseholdTierSnapshotRecord | null> => {
        return this.householdRows.get(args.where.householdId) ?? null;
      },
    ),
  };

  providerTierSnapshot = {
    upsert: vi.fn(
      async (args: {
        where: { providerId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }): Promise<ProviderTierSnapshotRecord> => {
        const existing = this.providerRows.get(args.where.providerId);
        if (existing) {
          const next: ProviderTierSnapshotRecord = {
            ...existing,
            tier: (args.update['tier'] as ProviderTierSnapshotRecord['tier']) ?? existing.tier,
            lastSyncedAt:
              (args.update['lastSyncedAt'] as Date | undefined) ?? existing.lastSyncedAt,
            sourceEventId:
              args.update['sourceEventId'] !== undefined
                ? (args.update['sourceEventId'] as string | null)
                : existing.sourceEventId,
            updatedAt: new Date('2026-05-14T12:05:00.000Z'),
          };
          this.providerRows.set(args.where.providerId, next);
          return next;
        }
        const row: ProviderTierSnapshotRecord = {
          providerId: args.create['providerId'] as string,
          tier: args.create['tier'] as ProviderTierSnapshotRecord['tier'],
          lastSyncedAt: args.create['lastSyncedAt'] as Date,
          sourceEventId: (args.create['sourceEventId'] as string | undefined) ?? null,
          createdAt: new Date('2026-05-14T12:00:00.000Z'),
          updatedAt: new Date('2026-05-14T12:00:00.000Z'),
        };
        this.providerRows.set(row.providerId, row);
        return row;
      },
    ),
    findUnique: vi.fn(
      async (args: {
        where: { providerId: string };
      }): Promise<ProviderTierSnapshotRecord | null> => {
        return this.providerRows.get(args.where.providerId) ?? null;
      },
    ),
  };
}

/**
 * In-memory `CatalogService` stand-in (TS-220-followup-1). `evaluate`
 * reads only `requiredProviderTier` off the catalog row, so the fake
 * supplies just that field. By default every kind has no row (`null`) —
 * the seven Phase-1 basic kinds carry `requiredProviderTier: null` in
 * production, behaviourally identical to "no row" for the gate. Tests
 * that exercise the catalog gate register a requirement per kind via
 * `setRequiredTier`.
 */
class FakeCatalog {
  private readonly requirements = new Map<string, 'basic' | 'certified' | 'elite' | null>();

  setRequiredTier(kind: string, tier: 'basic' | 'certified' | 'elite' | null): void {
    this.requirements.set(kind, tier);
  }

  getByKind = vi.fn(
    async (
      kind: string,
    ): Promise<{ requiredProviderTier: 'basic' | 'certified' | 'elite' | null } | null> => {
      if (!this.requirements.has(kind)) return null;
      return { requiredProviderTier: this.requirements.get(kind) ?? null };
    },
  );
}

function makeEnv(mode: 'enforce' | 'advisory'): Env {
  return {
    BOOKING_TIER_GATING_MODE: mode,
    BOOKING_TIER_DISPATCH_HEADER_NAME: 'x-internal-api-key',
    BOOKING_TIER_DISPATCH_API_KEY: 'x'.repeat(40),
    BOOKING_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME: 'x-internal-api-key',
    BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY: 'x'.repeat(40),
  } as unknown as Env;
}

function build(mode: 'enforce' | 'advisory'): {
  service: TierGatingService;
  prisma: FakePrisma;
  catalog: FakeCatalog;
} {
  const prisma = new FakePrisma();
  const catalog = new FakeCatalog();
  const service = new TierGatingService(
    prisma as unknown as PrismaService,
    catalog as unknown as CatalogService,
    makeEnv(mode),
  );
  const log = (service as unknown as { logger: Logger }).logger;
  log.log = vi.fn();
  log.warn = vi.fn();
  log.error = vi.fn();
  log.debug = vi.fn();
  return { service, prisma, catalog };
}

describe('TierGatingService.upsertHouseholdSnapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts a new household snapshot with sourceEventId null when omitted', async () => {
    const { service, prisma } = build('enforce');
    const result = await service.upsertHouseholdSnapshot({
      householdId: 'hh_abc',
      tier: 'tier_2_companion',
      lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tier).toBe('tier_2_companion');
    expect(result.value.sourceEventId).toBeNull();
    expect(prisma.householdTierSnapshot.upsert).toHaveBeenCalledTimes(1);
  });

  it('inserts a new household snapshot with sourceEventId when provided', async () => {
    const { service } = build('enforce');
    const result = await service.upsertHouseholdSnapshot({
      householdId: 'hh_abc',
      tier: 'tier_3_concierge',
      lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
      sourceEventId: 'evt_x',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.sourceEventId).toBe('evt_x');
  });

  it('updates an existing snapshot in place (tier flip)', async () => {
    const { service } = build('enforce');
    await service.upsertHouseholdSnapshot({
      householdId: 'hh_abc',
      tier: 'tier_1_essential',
      lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
    });
    const updated = await service.upsertHouseholdSnapshot({
      householdId: 'hh_abc',
      tier: 'tier_3_concierge',
      lastSyncedAt: new Date('2026-05-14T12:00:00.000Z'),
    });
    if (!updated.ok) throw new Error('expected ok');
    expect(updated.value.tier).toBe('tier_3_concierge');
  });

  it('rejects empty householdId with invalid_request', async () => {
    const { service } = build('enforce');
    const result = await service.upsertHouseholdSnapshot({
      householdId: '',
      tier: 'tier_1_essential',
      lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
  });
});

describe('TierGatingService.upsertProviderSnapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts a new provider snapshot', async () => {
    const { service } = build('enforce');
    const result = await service.upsertProviderSnapshot({
      providerId: 'prv_xyz',
      tier: 'elite',
      lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.tier).toBe('elite');
  });

  it('rejects empty providerId with invalid_request', async () => {
    const { service } = build('enforce');
    const result = await service.upsertProviderSnapshot({
      providerId: '',
      tier: 'basic',
      lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
    });
    expect(result.ok).toBe(false);
  });
});

describe('TierGatingService.evaluate — enforce mode', () => {
  beforeEach(() => vi.clearAllMocks());

  async function seed(
    svc: ReturnType<typeof build>,
    h: 'tier_1_essential' | 'tier_2_companion' | 'tier_3_concierge' | null,
    p: 'basic' | 'certified' | 'elite' | null,
  ): Promise<void> {
    if (h !== null) {
      await svc.service.upsertHouseholdSnapshot({
        householdId: 'hh_abc',
        tier: h,
        lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
      });
    }
    if (p !== null) {
      await svc.service.upsertProviderSnapshot({
        providerId: 'prv_xyz',
        tier: p,
        lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
      });
    }
  }

  it('allows tier_1 household × any provider tier', async () => {
    const svc = build('enforce');
    for (const provider of ['basic', 'certified', 'elite'] as const) {
      await seed(svc, 'tier_1_essential', provider);
      const decision = await svc.service.evaluate({
        householdId: 'hh_abc',
        providerId: 'prv_xyz',
        serviceKind: 'companion_dining',
      });
      expect(decision.outcome).toBe('allowed');
    }
  });

  it('allows tier_2 household × any provider tier', async () => {
    const svc = build('enforce');
    for (const provider of ['basic', 'certified', 'elite'] as const) {
      await seed(svc, 'tier_2_companion', provider);
      const decision = await svc.service.evaluate({
        householdId: 'hh_abc',
        providerId: 'prv_xyz',
        serviceKind: 'companion_dining',
      });
      expect(decision.outcome).toBe('allowed');
    }
  });

  it('allows tier_3 household × elite provider', async () => {
    const svc = build('enforce');
    await seed(svc, 'tier_3_concierge', 'elite');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'companion_dining',
    });
    expect(decision.outcome).toBe('allowed');
    if (decision.outcome !== 'allowed') return;
    expect(decision.householdTier).toBe('tier_3_concierge');
    expect(decision.providerTier).toBe('elite');
  });

  it('blocks tier_3 household × basic provider', async () => {
    const svc = build('enforce');
    await seed(svc, 'tier_3_concierge', 'basic');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'companion_dining',
    });
    expect(decision.outcome).toBe('blocked');
    if (decision.outcome !== 'blocked') return;
    expect(decision.reason).toBe('tier_3_requires_elite');
    expect(decision.householdTier).toBe('tier_3_concierge');
    expect(decision.providerTier).toBe('basic');
  });

  it('blocks tier_3 household × certified provider', async () => {
    const svc = build('enforce');
    await seed(svc, 'tier_3_concierge', 'certified');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'companion_dining',
    });
    expect(decision.outcome).toBe('blocked');
    if (decision.outcome !== 'blocked') return;
    expect(decision.reason).toBe('tier_3_requires_elite');
  });

  it('blocks when household snapshot is missing (provider known)', async () => {
    const svc = build('enforce');
    await seed(svc, null, 'elite');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'companion_dining',
    });
    expect(decision.outcome).toBe('blocked');
    if (decision.outcome !== 'blocked') return;
    expect(decision.reason).toBe('household_snapshot_unknown');
    expect(decision.householdTier).toBeNull();
    expect(decision.providerTier).toBe('elite');
  });

  it('blocks when provider snapshot is missing (household known)', async () => {
    const svc = build('enforce');
    await seed(svc, 'tier_1_essential', null);
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'companion_dining',
    });
    expect(decision.outcome).toBe('blocked');
    if (decision.outcome !== 'blocked') return;
    expect(decision.reason).toBe('provider_snapshot_unknown');
    expect(decision.householdTier).toBe('tier_1_essential');
    expect(decision.providerTier).toBeNull();
  });

  it('blocks with household-snapshot-unknown when both are missing (household-first)', async () => {
    const svc = build('enforce');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'companion_dining',
    });
    if (decision.outcome !== 'blocked') return;
    expect(decision.reason).toBe('household_snapshot_unknown');
  });
});

describe('TierGatingService.evaluate — advisory mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits allowed_with_advisory_warning on tier_3 × non-elite (same data; mode differs)', async () => {
    const svc = build('advisory');
    await svc.service.upsertHouseholdSnapshot({
      householdId: 'hh_abc',
      tier: 'tier_3_concierge',
      lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
    });
    await svc.service.upsertProviderSnapshot({
      providerId: 'prv_xyz',
      tier: 'basic',
      lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
    });
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'companion_dining',
    });
    expect(decision.outcome).toBe('allowed_with_advisory_warning');
    if (decision.outcome !== 'allowed_with_advisory_warning') return;
    expect(decision.reason).toBe('tier_3_requires_elite');
  });

  it('emits allowed_with_advisory_warning on missing snapshots (reason carries through)', async () => {
    const svc = build('advisory');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'companion_dining',
    });
    expect(decision.outcome).toBe('allowed_with_advisory_warning');
    if (decision.outcome !== 'allowed_with_advisory_warning') return;
    expect(decision.reason).toBe('household_snapshot_unknown');
  });

  it('emits allowed on a valid pair regardless of mode', async () => {
    const svc = build('advisory');
    await svc.service.upsertHouseholdSnapshot({
      householdId: 'hh_abc',
      tier: 'tier_3_concierge',
      lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
    });
    await svc.service.upsertProviderSnapshot({
      providerId: 'prv_xyz',
      tier: 'elite',
      lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
    });
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'companion_dining',
    });
    expect(decision.outcome).toBe('allowed');
  });
});

describe('TierGatingService.evaluate — per-service-kind catalog gate (TS-220-followup-1)', () => {
  beforeEach(() => vi.clearAllMocks());

  async function seedPair(
    svc: ReturnType<typeof build>,
    householdTier: 'tier_1_essential' | 'tier_2_companion' | 'tier_3_concierge',
    providerTier: 'basic' | 'certified' | 'elite',
  ): Promise<void> {
    await svc.service.upsertHouseholdSnapshot({
      householdId: 'hh_abc',
      tier: householdTier,
      lastSyncedAt: new Date('2026-05-26T10:00:00.000Z'),
    });
    await svc.service.upsertProviderSnapshot({
      providerId: 'prv_xyz',
      tier: providerTier,
      lastSyncedAt: new Date('2026-05-26T10:00:00.000Z'),
    });
  }

  it('blocks a Tier-1 household booking an Elite-required kind with a basic provider', async () => {
    const svc = build('enforce');
    svc.catalog.setRequiredTier('memory_meal', 'elite');
    await seedPair(svc, 'tier_1_essential', 'basic');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'memory_meal',
    });
    expect(decision.outcome).toBe('blocked');
    if (decision.outcome !== 'blocked') return;
    expect(decision.reason).toBe('service_kind_requires_higher_tier');
    expect(decision.householdTier).toBe('tier_1_essential');
    expect(decision.providerTier).toBe('basic');
  });

  it('blocks a Tier-2 household booking an Elite-required kind with a certified provider', async () => {
    const svc = build('enforce');
    svc.catalog.setRequiredTier('holiday_dinner', 'elite');
    await seedPair(svc, 'tier_2_companion', 'certified');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'holiday_dinner',
    });
    expect(decision.outcome).toBe('blocked');
    if (decision.outcome !== 'blocked') return;
    expect(decision.reason).toBe('service_kind_requires_higher_tier');
  });

  it('allows an Elite-required kind with an elite provider', async () => {
    const svc = build('enforce');
    svc.catalog.setRequiredTier('memory_meal', 'elite');
    await seedPair(svc, 'tier_1_essential', 'elite');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'memory_meal',
    });
    expect(decision.outcome).toBe('allowed');
  });

  it('allows a kind with no catalog row (no requirement) regardless of provider tier', async () => {
    const svc = build('enforce');
    // companion_dining has no requirement registered → fake returns null.
    await seedPair(svc, 'tier_1_essential', 'basic');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'companion_dining',
    });
    expect(decision.outcome).toBe('allowed');
  });

  it('allows a kind whose catalog row carries an explicit null requiredProviderTier', async () => {
    const svc = build('enforce');
    svc.catalog.setRequiredTier('companion_dining', null);
    await seedPair(svc, 'tier_1_essential', 'basic');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'companion_dining',
    });
    expect(decision.outcome).toBe('allowed');
  });

  it('treats the tier ladder ordinally — certified meets a certified requirement', async () => {
    const svc = build('enforce');
    svc.catalog.setRequiredTier('social_outing', 'certified');
    await seedPair(svc, 'tier_1_essential', 'certified');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'social_outing',
    });
    expect(decision.outcome).toBe('allowed');
  });

  it('treats the tier ladder ordinally — basic fails a certified requirement', async () => {
    const svc = build('enforce');
    svc.catalog.setRequiredTier('social_outing', 'certified');
    await seedPair(svc, 'tier_1_essential', 'basic');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'social_outing',
    });
    expect(decision.outcome).toBe('blocked');
    if (decision.outcome !== 'blocked') return;
    expect(decision.reason).toBe('service_kind_requires_higher_tier');
  });

  it('treats the tier ladder ordinally — elite exceeds a certified requirement', async () => {
    const svc = build('enforce');
    svc.catalog.setRequiredTier('social_outing', 'certified');
    await seedPair(svc, 'tier_1_essential', 'elite');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'social_outing',
    });
    expect(decision.outcome).toBe('allowed');
  });

  it('lets the per-household tier_3 rule take precedence over the catalog gate', async () => {
    // Tier-3 household + Elite-required kind + basic provider: BOTH rules
    // would block; the per-household rule is checked first so its
    // established `tier_3_requires_elite` reason wins.
    const svc = build('enforce');
    svc.catalog.setRequiredTier('memory_meal', 'elite');
    await seedPair(svc, 'tier_3_concierge', 'basic');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'memory_meal',
    });
    expect(decision.outcome).toBe('blocked');
    if (decision.outcome !== 'blocked') return;
    expect(decision.reason).toBe('tier_3_requires_elite');
  });

  it('advisory mode lets the catalog violation through with a warning', async () => {
    const svc = build('advisory');
    svc.catalog.setRequiredTier('memory_meal', 'elite');
    await seedPair(svc, 'tier_1_essential', 'basic');
    const decision = await svc.service.evaluate({
      householdId: 'hh_abc',
      providerId: 'prv_xyz',
      serviceKind: 'memory_meal',
    });
    expect(decision.outcome).toBe('allowed_with_advisory_warning');
    if (decision.outcome !== 'allowed_with_advisory_warning') return;
    expect(decision.reason).toBe('service_kind_requires_higher_tier');
  });
});

describe('TierGatingService.getMode', () => {
  it('returns the configured mode', () => {
    expect(build('enforce').service.getMode()).toBe('enforce');
    expect(build('advisory').service.getMode()).toBe('advisory');
  });
});
