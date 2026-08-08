import Decimal from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { PLAN_CATALOG } from './seed-catalog';
import { seedPlanCatalog } from './seed';

interface FakePlanRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  customerGroup: 'family' | 'provider' | 'academy';
  monthlyPrice: string;
  annualPrice: string;
  currency: string;
  features: unknown;
  active: boolean;
  sortPosition: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Minimal Prisma stand-in. `seedPlanCatalog` uses three methods:
 *   - prisma.plan.findUnique({ where: { code }, select })
 *   - prisma.plan.create({ data })
 *   - prisma.plan.update({ where: { code }, data })
 *   - prisma.$transaction(callback)
 *
 * `$transaction` simply runs the callback against the same fake — single-
 * test-scope isolation, no rollback semantics needed (mirrors the
 * other services' Prisma fakes; rollback fidelity is the
 * Testcontainers integration test's job).
 *
 * `monthlyPrice` / `annualPrice` are stored as the **string** Prisma
 * serialises for `Decimal` columns (`'29.00'`, `'1990.00'`); the
 * tests assert against the string round-trip so they catch a future
 * regression that accidentally rounds at the seed boundary.
 */
class FakePrisma {
  public rows: FakePlanRow[] = [];
  private autoId = 0;

  plan = {
    findUnique: vi.fn(async (args: { where: { code: string }; select: { id: true } }) => {
      const row = this.rows.find((r) => r.code === args.where.code);
      if (row === undefined) return null;
      return { id: row.id };
    }),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      this.autoId += 1;
      const row: FakePlanRow = {
        id: `plan_${this.autoId}`,
        code: args.data['code'] as string,
        name: args.data['name'] as string,
        description: (args.data['description'] as string | undefined) ?? null,
        customerGroup: args.data['customerGroup'] as 'family' | 'provider' | 'academy',
        monthlyPrice: args.data['monthlyPrice'] as string,
        annualPrice: args.data['annualPrice'] as string,
        currency: args.data['currency'] as string,
        features: args.data['features'],
        active: args.data['active'] as boolean,
        sortPosition: args.data['sortPosition'] as number,
        createdAt: new Date('2026-05-10T00:00:00.000Z'),
        updatedAt: new Date('2026-05-10T00:00:00.000Z'),
      };
      this.rows.push(row);
      return row;
    }),
    update: vi.fn(async (args: { where: { code: string }; data: Record<string, unknown> }) => {
      const row = this.rows.find((r) => r.code === args.where.code);
      if (row === undefined) throw new Error('plan row missing in fake');
      // Mirror real Prisma semantics: undefined skips the column, a
      // non-undefined value overwrites.
      for (const [key, value] of Object.entries(args.data)) {
        if (value === undefined) continue;
        (row as unknown as Record<string, unknown>)[key] = value;
      }
      row.updatedAt = new Date('2026-05-10T01:00:00.000Z');
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

describe('seedPlanCatalog', () => {
  it('inserts every Phase-1 plan on an empty database', async () => {
    const prisma = buildPrisma();

    const report = await seedPlanCatalog(prisma as unknown as PrismaService);

    expect(report.plansUpserted).toBe(PLAN_CATALOG.length);
    expect(report.created).toHaveLength(PLAN_CATALOG.length);
    expect(report.updated).toEqual([]);
    expect(prisma.rows).toHaveLength(PLAN_CATALOG.length);
  });

  it('seeds all seven Phase-1 plan codes from PRD §5', async () => {
    const prisma = buildPrisma();
    await seedPlanCatalog(prisma as unknown as PrismaService);

    const codes = prisma.rows.map((r) => r.code).sort();
    expect(codes).toEqual([
      'academy.membership',
      'family.tier1',
      'family.tier2',
      'family.tier3',
      'provider.basic',
      'provider.certified',
      'provider.elite',
    ]);
  });

  it('writes monthly/annual prices as Decimal-friendly fixed-2 strings', async () => {
    const prisma = buildPrisma();
    await seedPlanCatalog(prisma as unknown as PrismaService);

    // family.tier1 = $29/mo, $290/yr — assert the exact string shape
    // because Prisma's Decimal column round-trips strings, not floats.
    const essential = prisma.rows.find((r) => r.code === 'family.tier1');
    expect(essential).toBeDefined();
    expect(essential?.monthlyPrice).toBe('29.00');
    expect(essential?.annualPrice).toBe('290.00');

    // family.tier3 = $1000/mo, $10000/yr — bigger value, same shape.
    const concierge = prisma.rows.find((r) => r.code === 'family.tier3');
    expect(concierge?.monthlyPrice).toBe('1000.00');
    expect(concierge?.annualPrice).toBe('10000.00');
  });

  it('is idempotent on a second run (no rows created, every row updated)', async () => {
    const prisma = buildPrisma();

    await seedPlanCatalog(prisma as unknown as PrismaService);
    const reportSecond = await seedPlanCatalog(prisma as unknown as PrismaService);

    expect(reportSecond.created).toEqual([]);
    expect(reportSecond.updated).toHaveLength(PLAN_CATALOG.length);
    expect(prisma.rows).toHaveLength(PLAN_CATALOG.length);
  });

  it('preserves the row id across reseeds (subscription FK stability)', async () => {
    const prisma = buildPrisma();

    await seedPlanCatalog(prisma as unknown as PrismaService);
    const before = new Map(prisma.rows.map((r) => [r.code, r.id]));

    await seedPlanCatalog(prisma as unknown as PrismaService);
    const after = new Map(prisma.rows.map((r) => [r.code, r.id]));

    for (const [code, id] of before) {
      expect(after.get(code)).toBe(id);
    }
  });

  it('refreshes mutable columns on the second run when the catalog changes', async () => {
    const prisma = buildPrisma();

    await seedPlanCatalog(prisma as unknown as PrismaService);
    // Simulate operator drift — flip an active flag, change a price.
    const essential = prisma.rows.find((r) => r.code === 'family.tier1');
    expect(essential).toBeDefined();
    if (essential !== undefined) {
      essential.active = false;
      essential.monthlyPrice = '99.99';
    }

    await seedPlanCatalog(prisma as unknown as PrismaService);

    const afterReseed = prisma.rows.find((r) => r.code === 'family.tier1');
    expect(afterReseed?.active).toBe(true);
    expect(afterReseed?.monthlyPrice).toBe('29.00');
  });

  it('writes features as a string array', async () => {
    const prisma = buildPrisma();
    await seedPlanCatalog(prisma as unknown as PrismaService);

    const essential = prisma.rows.find((r) => r.code === 'family.tier1');
    expect(Array.isArray(essential?.features)).toBe(true);
    const features = essential?.features as readonly unknown[];
    expect(features.length).toBeGreaterThan(0);
    for (const entry of features) {
      expect(typeof entry).toBe('string');
    }
  });

  it('places each plan in the right customer_group with a sane sort_position', async () => {
    const prisma = buildPrisma();
    await seedPlanCatalog(prisma as unknown as PrismaService);

    const byCode = new Map(prisma.rows.map((r) => [r.code, r]));
    // Family tiers
    expect(byCode.get('family.tier1')?.customerGroup).toBe('family');
    expect(byCode.get('family.tier1')?.sortPosition).toBe(0);
    expect(byCode.get('family.tier2')?.sortPosition).toBe(1);
    expect(byCode.get('family.tier3')?.sortPosition).toBe(2);
    // Provider tiers
    expect(byCode.get('provider.basic')?.customerGroup).toBe('provider');
    expect(byCode.get('provider.basic')?.sortPosition).toBe(0);
    expect(byCode.get('provider.certified')?.sortPosition).toBe(1);
    expect(byCode.get('provider.elite')?.sortPosition).toBe(2);
    // Academy
    expect(byCode.get('academy.membership')?.customerGroup).toBe('academy');
    expect(byCode.get('academy.membership')?.sortPosition).toBe(0);
  });

  it('snapshot — annual = monthly * 10 for every catalog entry (PRD §5 "two months free")', () => {
    for (const entry of PLAN_CATALOG) {
      const expected = entry.monthlyPrice.mul(10);
      expect(entry.annualPrice.equals(expected)).toBe(true);
    }
  });

  it('every catalog code is unique', () => {
    const codes = new Set(PLAN_CATALOG.map((e) => e.code));
    expect(codes.size).toBe(PLAN_CATALOG.length);
  });

  it('every catalog price is non-negative', () => {
    for (const entry of PLAN_CATALOG) {
      expect(entry.monthlyPrice.gte(new Decimal(0))).toBe(true);
      expect(entry.annualPrice.gte(new Decimal(0))).toBe(true);
    }
  });
});
