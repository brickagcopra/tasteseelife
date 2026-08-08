import Decimal from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { PlansService } from './plans.service';

interface FakePlanRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  customerGroup: 'family' | 'provider' | 'academy';
  monthlyPrice: Decimal;
  annualPrice: Decimal;
  currency: string;
  features: unknown;
  active: boolean;
  sortPosition: number;
  createdAt: Date;
  updatedAt: Date;
}

interface FindManyArgs {
  readonly where: { active: boolean };
  readonly select: Record<string, true>;
  readonly orderBy: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
}

/**
 * Minimal Prisma stand-in. `PlansService` uses exactly one model method:
 *   - prisma.plan.findMany({ where, select, orderBy })
 *
 * The fake mirrors the production behaviour:
 *   - `where.active === true` filters out inactive rows.
 *   - `orderBy` is honoured as a multi-key tuple comparator.
 *   - `select` keys are recorded for assertion in the projection test;
 *     the fake returns the full row (Prisma's runtime ignores extra
 *     select keys, so a permissive fake matches production behaviour).
 */
class FakePrisma {
  public rows: FakePlanRow[] = [];
  public lastSelect: Record<string, true> | null = null;

  plan = {
    findMany: vi.fn(async (args: FindManyArgs): Promise<FakePlanRow[]> => {
      this.lastSelect = args.select;
      const filtered = this.rows.filter((r) => r.active === args.where.active);
      // Multi-key comparator matching `customerGroup` then `sortPosition`
      // then `code` (the orderBy the service supplies). Implemented as a
      // stable sort by iterating the keys in declared order.
      const sorted = [...filtered];
      for (let i = args.orderBy.length - 1; i >= 0; i--) {
        const clause = args.orderBy[i]!;
        const [key, direction] = Object.entries(clause)[0] as [string, 'asc' | 'desc'];
        sorted.sort((a, b) => {
          const av = (a as unknown as Record<string, unknown>)[key];
          const bv = (b as unknown as Record<string, unknown>)[key];
          if (av === bv) return 0;
          const lt =
            typeof av === 'number' && typeof bv === 'number' ? av < bv : String(av) < String(bv);
          const cmp = lt ? -1 : 1;
          return direction === 'asc' ? cmp : -cmp;
        });
      }
      return sorted;
    }),
  };
}

function buildSvc(): { service: PlansService; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  const service = new PlansService(prisma as unknown as PrismaService);
  return { service, prisma };
}

function buildRow(overrides: Partial<FakePlanRow> = {}): FakePlanRow {
  return {
    id: 'plan_seed',
    code: 'family.tier1',
    name: 'Essential',
    description: 'Base mass-market membership.',
    customerGroup: 'family',
    monthlyPrice: new Decimal('29.00'),
    annualPrice: new Decimal('290.00'),
    currency: 'USD',
    features: ['App access'],
    active: true,
    sortPosition: 0,
    createdAt: new Date('2026-05-10T00:00:00.000Z'),
    updatedAt: new Date('2026-05-10T00:00:00.000Z'),
    ...overrides,
  };
}

describe('PlansService.listActive', () => {
  it('returns an empty array when the catalog is empty', async () => {
    const { service } = buildSvc();
    const result = await service.listActive();
    expect(result).toEqual([]);
  });

  it('filters out inactive plans', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(
      buildRow({ id: 'p_active', code: 'family.tier1', active: true }),
      buildRow({ id: 'p_retired', code: 'family.legacy', active: false }),
    );

    const result = await service.listActive();
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe('family.tier1');
  });

  it('orders by customerGroup, then sortPosition, then code', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(
      buildRow({ id: 'p1', code: 'family.tier3', customerGroup: 'family', sortPosition: 2 }),
      buildRow({ id: 'p2', code: 'family.tier1', customerGroup: 'family', sortPosition: 0 }),
      buildRow({ id: 'p3', code: 'family.tier2', customerGroup: 'family', sortPosition: 1 }),
      buildRow({ id: 'p4', code: 'provider.basic', customerGroup: 'provider', sortPosition: 0 }),
      buildRow({
        id: 'p5',
        code: 'academy.membership',
        customerGroup: 'academy',
        sortPosition: 0,
      }),
    );

    const result = await service.listActive();
    // Customer-group ASC (academy < family < provider lexicographically),
    // then sort_position ASC, then code ASC.
    expect(result.map((p) => p.code)).toEqual([
      'academy.membership',
      'family.tier1',
      'family.tier2',
      'family.tier3',
      'provider.basic',
    ]);
  });

  it('breaks ties on identical sortPositions deterministically by code', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(
      buildRow({ id: 'p_b', code: 'family.b', customerGroup: 'family', sortPosition: 0 }),
      buildRow({ id: 'p_a', code: 'family.a', customerGroup: 'family', sortPosition: 0 }),
    );

    const result = await service.listActive();
    expect(result.map((p) => p.code)).toEqual(['family.a', 'family.b']);
  });

  it('converts Decimal monthly/annual prices to integer USD minor units', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(
      buildRow({
        monthlyPrice: new Decimal('199.00'),
        annualPrice: new Decimal('1990.00'),
      }),
    );

    const [plan] = await service.listActive();
    expect(plan?.monthlyPriceUsdMinor).toBe(19900);
    expect(plan?.annualPriceUsdMinor).toBe(199000);
  });

  it('handles fractional Decimal cents (e.g. 29.99) via half-even rounding', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(
      buildRow({
        monthlyPrice: new Decimal('29.99'),
        annualPrice: new Decimal('299.99'),
      }),
    );

    const [plan] = await service.listActive();
    expect(plan?.monthlyPriceUsdMinor).toBe(2999);
    expect(plan?.annualPriceUsdMinor).toBe(29999);
  });

  it('handles large Decimal values without losing precision', async () => {
    const { service, prisma } = buildSvc();
    // Tier 3 Concierge Lifestyle hits $5000/mo at the top of its range
    // per PRD §5.1; the schema supports Decimal(12,2) so up to
    // 9_999_999_999.99 (~$10B) is representable.
    prisma.rows.push(
      buildRow({
        monthlyPrice: new Decimal('5000.00'),
        annualPrice: new Decimal('50000.00'),
      }),
    );

    const [plan] = await service.listActive();
    expect(plan?.monthlyPriceUsdMinor).toBe(500000);
    expect(plan?.annualPriceUsdMinor).toBe(5000000);
  });

  it('omits `description` when the column is null', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ description: null }));

    const [plan] = await service.listActive();
    expect(plan).not.toHaveProperty('description');
  });

  it('includes `description` when the column is non-null', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ description: 'Some marketing copy' }));

    const [plan] = await service.listActive();
    expect(plan?.description).toBe('Some marketing copy');
  });

  it('returns the features array intact when well-shaped', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ features: ['App access', 'Wellness resources'] }));

    const [plan] = await service.listActive();
    expect(plan?.features).toEqual(['App access', 'Wellness resources']);
  });

  it('coerces a non-array features value to an empty array (defence-in-depth)', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ features: { 0: 'not-an-array' } }));

    const [plan] = await service.listActive();
    expect(plan?.features).toEqual([]);
  });

  it('filters non-string entries out of a mixed features array (defence-in-depth)', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ features: ['App access', 42, null, 'Family dashboard'] }));

    const [plan] = await service.listActive();
    expect(plan?.features).toEqual(['App access', 'Family dashboard']);
  });

  it('emits ISO-8601 datetime strings for createdAt / updatedAt', async () => {
    const { service, prisma } = buildSvc();
    const created = new Date('2026-05-10T12:34:56.000Z');
    const updated = new Date('2026-05-10T13:00:00.000Z');
    prisma.rows.push(buildRow({ createdAt: created, updatedAt: updated }));

    const [plan] = await service.listActive();
    expect(plan?.createdAt).toBe('2026-05-10T12:34:56.000Z');
    expect(plan?.updatedAt).toBe('2026-05-10T13:00:00.000Z');
  });

  it('throws on an unsupported currency (defence-in-depth)', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ currency: 'EUR' }));

    await expect(service.listActive()).rejects.toThrow(/unsupported currency/);
  });

  it('uses a narrow column projection (no SELECT * in production paths)', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow());

    await service.listActive();
    expect(prisma.lastSelect).toEqual({
      id: true,
      code: true,
      name: true,
      description: true,
      customerGroup: true,
      monthlyPrice: true,
      annualPrice: true,
      currency: true,
      features: true,
      active: true,
      sortPosition: true,
      createdAt: true,
      updatedAt: true,
    });
  });
});
