import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { ChartOfAccountsService } from './chart-of-accounts.service';

interface FakeAccountRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'contra_revenue' | 'expense';
  parentId: string | null;
  normalBalance: 'debit' | 'credit';
  currency: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface FindManyArgs {
  readonly where: {
    active?: boolean;
    type?: FakeAccountRow['type'];
    parentId?: string | null;
  };
  readonly select: Record<string, true>;
  readonly orderBy: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
}

class FakePrisma {
  public rows: FakeAccountRow[] = [];
  public lastWhere: FindManyArgs['where'] | null = null;
  public lastSelect: Record<string, true> | null = null;

  chartOfAccount = {
    findMany: vi.fn(async (args: FindManyArgs): Promise<FakeAccountRow[]> => {
      this.lastWhere = args.where;
      this.lastSelect = args.select;
      let filtered = [...this.rows];
      if (args.where.active === true) {
        filtered = filtered.filter((r) => r.active);
      } else if (args.where.active === false) {
        filtered = filtered.filter((r) => !r.active);
      }
      if (args.where.type !== undefined) {
        filtered = filtered.filter((r) => r.type === args.where.type);
      }
      if (args.where.parentId !== undefined) {
        filtered = filtered.filter((r) => r.parentId === args.where.parentId);
      }
      const sorted = [...filtered];
      for (let i = args.orderBy.length - 1; i >= 0; i--) {
        const clause = args.orderBy[i]!;
        const [key, direction] = Object.entries(clause)[0] as [string, 'asc' | 'desc'];
        sorted.sort((a, b) => {
          const av = (a as unknown as Record<string, unknown>)[key];
          const bv = (b as unknown as Record<string, unknown>)[key];
          if (av === bv) return 0;
          const lt = String(av) < String(bv);
          const cmp = lt ? -1 : 1;
          return direction === 'asc' ? cmp : -cmp;
        });
      }
      return sorted;
    }),
  };
}

function buildSvc(): { service: ChartOfAccountsService; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  const service = new ChartOfAccountsService(prisma as unknown as PrismaService);
  return { service, prisma };
}

function buildRow(overrides: Partial<FakeAccountRow> = {}): FakeAccountRow {
  return {
    id: 'coa_cash',
    code: '1000',
    name: 'Cash',
    description: 'Operating bank + Stripe balance.',
    type: 'asset',
    parentId: null,
    normalBalance: 'debit',
    currency: 'USD',
    active: true,
    createdAt: new Date('2026-05-13T00:00:00.000Z'),
    updatedAt: new Date('2026-05-13T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ChartOfAccountsService.list', () => {
  it('returns an empty array when the catalog is empty', async () => {
    const { service } = buildSvc();
    const result = await service.list({ activeOnly: true });
    expect(result).toEqual([]);
  });

  it('returns active accounts ordered by code (lexicographic)', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(
      buildRow({
        code: '4000',
        name: 'Subscription Revenue',
        type: 'revenue',
        normalBalance: 'credit',
      }),
      buildRow({ code: '1000', name: 'Cash', type: 'asset' }),
      buildRow({
        code: '2000',
        name: 'Deferred Revenue',
        type: 'liability',
        normalBalance: 'credit',
      }),
    );

    const result = await service.list({ activeOnly: true });
    expect(result.map((r) => r.code)).toEqual(['1000', '2000', '4000']);
  });

  it('omits inactive accounts when activeOnly is true', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(
      buildRow({ code: '1000', name: 'Cash' }),
      buildRow({ code: '1900', name: 'Retired Suspense', active: false }),
    );

    const result = await service.list({ activeOnly: true });
    expect(result.map((r) => r.code)).toEqual(['1000']);
    expect(prisma.lastWhere?.active).toBe(true);
  });

  it('includes inactive accounts when activeOnly is false', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(
      buildRow({ code: '1000', name: 'Cash' }),
      buildRow({ code: '1900', name: 'Retired Suspense', active: false }),
    );

    const result = await service.list({ activeOnly: false });
    expect(result.map((r) => r.code)).toEqual(['1000', '1900']);
    expect(prisma.lastWhere?.active).toBeUndefined();
  });

  it('filters by type', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(
      buildRow({ code: '1000', name: 'Cash', type: 'asset' }),
      buildRow({
        code: '4000',
        name: 'Subscription Revenue',
        type: 'revenue',
        normalBalance: 'credit',
      }),
      buildRow({
        code: '4510',
        name: 'Coupon Discount',
        type: 'contra_revenue',
        normalBalance: 'debit',
      }),
    );

    const result = await service.list({
      activeOnly: true,
      type: 'contra_revenue',
    });
    expect(result.map((r) => r.code)).toEqual(['4510']);
    expect(prisma.lastWhere?.type).toBe('contra_revenue');
  });

  it('filters by parentId (sub-account drilldown)', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(
      buildRow({
        code: '2000',
        name: 'Deferred Revenue',
        type: 'liability',
        normalBalance: 'credit',
      }),
      buildRow({
        id: 'coa_t2',
        code: '2000.family.tier2',
        name: 'Deferred Revenue — Tier 2',
        type: 'liability',
        parentId: 'coa_cash', // intentionally wrong to verify the filter
        normalBalance: 'credit',
      }),
      buildRow({
        id: 'coa_t1',
        code: '2000.family.tier1',
        name: 'Deferred Revenue — Tier 1',
        type: 'liability',
        parentId: 'coa_2000',
        normalBalance: 'credit',
      }),
    );

    const result = await service.list({
      activeOnly: true,
      parentId: 'coa_2000',
    });
    expect(result.map((r) => r.code)).toEqual(['2000.family.tier1']);
  });

  it('treats parentId = "null" (literal) as top-level only', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(
      buildRow({ id: 'coa_1000', code: '1000', name: 'Cash' }),
      buildRow({
        id: 'coa_t1',
        code: '2000.family.tier1',
        name: 'Deferred Revenue — Tier 1',
        type: 'liability',
        parentId: 'coa_2000',
        normalBalance: 'credit',
      }),
    );

    const result = await service.list({
      activeOnly: true,
      parentId: 'null',
    });
    expect(result.map((r) => r.code)).toEqual(['1000']);
    expect(prisma.lastWhere?.parentId).toBeNull();
  });

  it('serialises Date columns as ISO-8601 strings', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(
      buildRow({
        createdAt: new Date('2026-05-13T12:34:56.000Z'),
        updatedAt: new Date('2026-05-13T13:00:00.000Z'),
      }),
    );

    const [row] = await service.list({ activeOnly: true });
    expect(row?.createdAt).toBe('2026-05-13T12:34:56.000Z');
    expect(row?.updatedAt).toBe('2026-05-13T13:00:00.000Z');
  });

  it('omits description when the column is null', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ description: null }));

    const [row] = await service.list({ activeOnly: true });
    expect(row).toBeDefined();
    expect('description' in (row as object)).toBe(false);
  });

  it('throws on an unsupported currency in the persisted row', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ currency: 'EUR' }));

    await expect(service.list({ activeOnly: true })).rejects.toThrow(/unsupported currency/);
  });

  it('uses a stable explicit projection (no SELECT *)', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow());
    await service.list({ activeOnly: true });
    expect(prisma.lastSelect).not.toBeNull();
    // Spot-check: the projection includes the columns we render.
    expect(prisma.lastSelect?.['id']).toBe(true);
    expect(prisma.lastSelect?.['code']).toBe(true);
    expect(prisma.lastSelect?.['type']).toBe(true);
    expect(prisma.lastSelect?.['normalBalance']).toBe(true);
    expect(prisma.lastSelect?.['parentId']).toBe(true);
  });
});
