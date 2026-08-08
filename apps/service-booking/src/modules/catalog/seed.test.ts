import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { SERVICE_CATALOG_SEED } from './seed-catalog';
import { seedServiceCatalog } from './seed';

interface FakeCatalogRow {
  id: string;
  kind: string;
  name: string;
  description: string;
  baseRateMin: string;
  baseRateMax: string;
  durationMinutes: number;
  currency: string;
  active: boolean;
  requiredProviderTier: 'basic' | 'certified' | 'elite' | null;
  sortPosition: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Minimal Prisma stand-in. `seedServiceCatalog` uses:
 *   - prisma.serviceCatalogEntry.findUnique({ where: { kind }, select })
 *   - prisma.serviceCatalogEntry.create({ data })
 *   - prisma.serviceCatalogEntry.update({ where: { kind }, data })
 *   - prisma.$transaction(callback)
 *
 * `$transaction` runs the callback against the same fake — single-test
 * isolation, no rollback semantics (mirrors the plan-seed fake;
 * rollback fidelity is the Testcontainers integration test's job).
 *
 * Rate columns are stored as the **string** Prisma serialises for
 * `Decimal` columns (`'150.00'`); the tests assert the string round-trip
 * so they catch a regression that accidentally rounds at the seed
 * boundary.
 */
class FakePrisma {
  public rows: FakeCatalogRow[] = [];
  private autoId = 0;

  serviceCatalogEntry = {
    findUnique: vi.fn(async (args: { where: { kind: string }; select: { id: true } }) => {
      const row = this.rows.find((r) => r.kind === args.where.kind);
      if (row === undefined) return null;
      return { id: row.id };
    }),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      this.autoId += 1;
      const row: FakeCatalogRow = {
        id: `cat_${this.autoId}`,
        kind: args.data['kind'] as string,
        name: args.data['name'] as string,
        description: args.data['description'] as string,
        baseRateMin: args.data['baseRateMin'] as string,
        baseRateMax: args.data['baseRateMax'] as string,
        durationMinutes: args.data['durationMinutes'] as number,
        currency: args.data['currency'] as string,
        active: args.data['active'] as boolean,
        requiredProviderTier: args.data[
          'requiredProviderTier'
        ] as FakeCatalogRow['requiredProviderTier'],
        sortPosition: args.data['sortPosition'] as number,
        createdAt: new Date('2026-05-25T00:00:00.000Z'),
        updatedAt: new Date('2026-05-25T00:00:00.000Z'),
      };
      this.rows.push(row);
      return row;
    }),
    update: vi.fn(async (args: { where: { kind: string }; data: Record<string, unknown> }) => {
      const row = this.rows.find((r) => r.kind === args.where.kind);
      if (row === undefined) throw new Error('catalog row missing in fake');
      for (const [key, value] of Object.entries(args.data)) {
        if (value === undefined) continue;
        (row as unknown as Record<string, unknown>)[key] = value;
      }
      row.updatedAt = new Date('2026-05-25T01:00:00.000Z');
      return row;
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction = vi.fn(async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
    return fn(this);
  });
}

function buildPrisma(): FakePrisma {
  return new FakePrisma();
}

describe('seedServiceCatalog', () => {
  it('inserts every Phase-1 catalog entry on an empty database', async () => {
    const prisma = buildPrisma();

    const report = await seedServiceCatalog(prisma as unknown as PrismaService);

    expect(report.entriesUpserted).toBe(SERVICE_CATALOG_SEED.length);
    expect(report.created).toHaveLength(SERVICE_CATALOG_SEED.length);
    expect(report.updated).toEqual([]);
    expect(prisma.rows).toHaveLength(SERVICE_CATALOG_SEED.length);
  });

  it('seeds every basic + Tier-3 concierge service kind', async () => {
    const prisma = buildPrisma();
    await seedServiceCatalog(prisma as unknown as PrismaService);

    const kinds = prisma.rows.map((r) => r.kind).sort();
    expect(kinds).toEqual([
      'birthday_experience',
      'companion_dining',
      'custom_request',
      'emergency_concierge',
      'event_dining',
      'grocery_coordination',
      'holiday_dinner',
      'memory_meal',
      'museum_outing',
      'personal_chef_visit',
      'social_outing',
      'tea_social',
      'transportation',
    ]);
  });

  it('writes rate bands as Decimal-friendly fixed-2 strings', async () => {
    const prisma = buildPrisma();
    await seedServiceCatalog(prisma as unknown as PrismaService);

    const companion = prisma.rows.find((r) => r.kind === 'companion_dining');
    expect(companion).toBeDefined();
    // $150.00 → $250.00
    expect(companion?.baseRateMin).toBe('150.00');
    expect(companion?.baseRateMax).toBe('250.00');

    const event = prisma.rows.find((r) => r.kind === 'event_dining');
    // $350.00 → $600.00 — bigger value, same shape.
    expect(event?.baseRateMin).toBe('350.00');
    expect(event?.baseRateMax).toBe('600.00');
  });

  it('is idempotent on a second run (no rows created, every row updated)', async () => {
    const prisma = buildPrisma();

    await seedServiceCatalog(prisma as unknown as PrismaService);
    const second = await seedServiceCatalog(prisma as unknown as PrismaService);

    expect(second.created).toEqual([]);
    expect(second.updated).toHaveLength(SERVICE_CATALOG_SEED.length);
    expect(prisma.rows).toHaveLength(SERVICE_CATALOG_SEED.length);
  });

  it('preserves the row id across reseeds (FK / reference stability)', async () => {
    const prisma = buildPrisma();

    await seedServiceCatalog(prisma as unknown as PrismaService);
    const before = new Map(prisma.rows.map((r) => [r.kind, r.id]));

    await seedServiceCatalog(prisma as unknown as PrismaService);
    const after = new Map(prisma.rows.map((r) => [r.kind, r.id]));

    for (const [kind, id] of before) {
      expect(after.get(kind)).toBe(id);
    }
  });

  it('refreshes mutable columns on the second run when an operator drifts them', async () => {
    const prisma = buildPrisma();

    await seedServiceCatalog(prisma as unknown as PrismaService);
    // Simulate operator drift — flip an active flag + change a rate.
    const companion = prisma.rows.find((r) => r.kind === 'companion_dining');
    expect(companion).toBeDefined();
    if (companion !== undefined) {
      companion.active = false;
      companion.baseRateMin = '999.99';
    }

    await seedServiceCatalog(prisma as unknown as PrismaService);

    const after = prisma.rows.find((r) => r.kind === 'companion_dining');
    expect(after?.active).toBe(true);
    expect(after?.baseRateMin).toBe('150.00');
  });

  it('places each kind at the expected sort position', async () => {
    const prisma = buildPrisma();
    await seedServiceCatalog(prisma as unknown as PrismaService);

    const byKind = new Map(prisma.rows.map((r) => [r.kind, r]));
    expect(byKind.get('companion_dining')?.sortPosition).toBe(0);
    expect(byKind.get('personal_chef_visit')?.sortPosition).toBe(1);
    expect(byKind.get('grocery_coordination')?.sortPosition).toBe(2);
    expect(byKind.get('transportation')?.sortPosition).toBe(3);
    expect(byKind.get('social_outing')?.sortPosition).toBe(4);
    expect(byKind.get('event_dining')?.sortPosition).toBe(5);
    expect(byKind.get('emergency_concierge')?.sortPosition).toBe(6);
    expect(byKind.get('holiday_dinner')?.sortPosition).toBe(7);
    expect(byKind.get('birthday_experience')?.sortPosition).toBe(8);
    expect(byKind.get('tea_social')?.sortPosition).toBe(9);
    expect(byKind.get('museum_outing')?.sortPosition).toBe(10);
    expect(byKind.get('memory_meal')?.sortPosition).toBe(11);
    expect(byKind.get('custom_request')?.sortPosition).toBe(12);
  });

  it('gates Tier-3 concierge kinds to elite and leaves basic kinds tier-agnostic', async () => {
    const prisma = buildPrisma();
    await seedServiceCatalog(prisma as unknown as PrismaService);

    const byKind = new Map(prisma.rows.map((r) => [r.kind, r]));
    // Tier-3 concierge experiences (PRD §6.6) require an Elite provider.
    for (const kind of [
      'holiday_dinner',
      'birthday_experience',
      'tea_social',
      'museum_outing',
      'memory_meal',
      'custom_request',
    ]) {
      expect(byKind.get(kind)?.requiredProviderTier).toBe('elite');
    }
    // Basic-marketplace kinds carry no tier gate.
    for (const kind of [
      'companion_dining',
      'personal_chef_visit',
      'grocery_coordination',
      'transportation',
      'social_outing',
      'event_dining',
      'emergency_concierge',
    ]) {
      expect(byKind.get(kind)?.requiredProviderTier).toBeNull();
    }
  });

  it('seeds USD currency on every entry', async () => {
    const prisma = buildPrisma();
    await seedServiceCatalog(prisma as unknown as PrismaService);
    for (const row of prisma.rows) {
      expect(row.currency).toBe('USD');
    }
  });

  it('every seed entry keeps min ≤ max (band invariant)', () => {
    for (const entry of SERVICE_CATALOG_SEED) {
      expect(entry.baseRateMinMinor).toBeLessThanOrEqual(entry.baseRateMaxMinor);
    }
  });

  it('every seed kind is unique', () => {
    const kinds = new Set(SERVICE_CATALOG_SEED.map((e) => e.kind));
    expect(kinds.size).toBe(SERVICE_CATALOG_SEED.length);
  });

  it('every seed sort position is unique and contiguous from 0', () => {
    const positions = SERVICE_CATALOG_SEED.map((e) => e.sortPosition).sort((a, b) => a - b);
    expect(positions).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});
