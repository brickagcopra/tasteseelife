import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { CHART_OF_ACCOUNTS_CATALOG } from './seed-catalog';
import { seedChartOfAccounts } from './seed';

interface FakeAccountRow {
  id: string;
  code: string;
  name: string;
  description: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'contra_revenue' | 'expense';
  parentId: string | null;
  normalBalance: 'debit' | 'credit';
  currency: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Minimal Prisma stand-in. `seedChartOfAccounts` uses:
 *   - prisma.chartOfAccount.findUnique({ where: { code }, select })
 *   - prisma.chartOfAccount.create({ data })
 *   - prisma.chartOfAccount.update({ where: { code }, data })
 *   - prisma.$transaction(callback)
 *
 * `$transaction` simply runs the callback against the same fake — single-
 * test-scope isolation, no rollback semantics needed (mirrors the
 * other services' Prisma fakes; rollback fidelity is the
 * Testcontainers integration test's job).
 */
class FakePrisma {
  public rows: FakeAccountRow[] = [];
  private autoId = 0;

  chartOfAccount = {
    findUnique: vi.fn(async (args: { where: { code: string }; select: { id: true } }) => {
      const row = this.rows.find((r) => r.code === args.where.code);
      if (row === undefined) return null;
      return { id: row.id };
    }),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      this.autoId += 1;
      const row: FakeAccountRow = {
        id: `coa_${this.autoId}`,
        code: args.data['code'] as string,
        name: args.data['name'] as string,
        description: args.data['description'] as string,
        type: args.data['type'] as FakeAccountRow['type'],
        parentId: (args.data['parentId'] as string | null | undefined) ?? null,
        normalBalance: args.data['normalBalance'] as 'debit' | 'credit',
        currency: args.data['currency'] as string,
        active: args.data['active'] as boolean,
        createdAt: new Date('2026-05-13T00:00:00.000Z'),
        updatedAt: new Date('2026-05-13T00:00:00.000Z'),
      };
      this.rows.push(row);
      return row;
    }),
    update: vi.fn(async (args: { where: { code: string }; data: Record<string, unknown> }) => {
      const row = this.rows.find((r) => r.code === args.where.code);
      if (row === undefined) throw new Error('account row missing in fake');
      for (const [key, value] of Object.entries(args.data)) {
        if (value === undefined) continue;
        (row as unknown as Record<string, unknown>)[key] = value;
      }
      row.updatedAt = new Date('2026-05-13T01:00:00.000Z');
      return row;
    }),
  };

  $transaction = vi.fn(async <T>(callback: (tx: FakePrisma) => Promise<T>): Promise<T> => {
    return callback(this);
  });
}

describe('seedChartOfAccounts', () => {
  it('creates every catalog row on a fresh database', async () => {
    const prisma = new FakePrisma();
    const report = await seedChartOfAccounts(prisma as unknown as PrismaService);

    expect(report.accountsUpserted).toBe(CHART_OF_ACCOUNTS_CATALOG.length);
    expect(report.created).toHaveLength(CHART_OF_ACCOUNTS_CATALOG.length);
    expect(report.updated).toEqual([]);

    for (const entry of CHART_OF_ACCOUNTS_CATALOG) {
      const persisted = prisma.rows.find((r) => r.code === entry.code);
      expect(persisted, `${entry.code} missing after seed`).toBeDefined();
      expect(persisted?.name).toBe(entry.name);
      expect(persisted?.type).toBe(entry.type);
      expect(persisted?.normalBalance).toBe(entry.normalBalance);
      expect(persisted?.currency).toBe(entry.currency);
      expect(persisted?.active).toBe(entry.active);
    }
  });

  it('resolves parent_id by looking up the parent account on each child', async () => {
    const prisma = new FakePrisma();
    await seedChartOfAccounts(prisma as unknown as PrismaService);

    const deferredRevenueParent = prisma.rows.find((r) => r.code === '2000');
    expect(deferredRevenueParent).toBeDefined();
    expect(deferredRevenueParent?.parentId).toBeNull();

    const tier2Deferred = prisma.rows.find((r) => r.code === '2000.family.tier2');
    expect(tier2Deferred).toBeDefined();
    expect(tier2Deferred?.parentId).toBe(deferredRevenueParent?.id);
  });

  it('is idempotent — a second run touches every existing row via update, never create', async () => {
    const prisma = new FakePrisma();
    await seedChartOfAccounts(prisma as unknown as PrismaService);
    const idsBefore = new Map(prisma.rows.map((r) => [r.code, r.id]));

    prisma.chartOfAccount.create.mockClear();
    prisma.chartOfAccount.update.mockClear();
    const report = await seedChartOfAccounts(prisma as unknown as PrismaService);

    expect(report.created).toEqual([]);
    expect(report.updated).toHaveLength(CHART_OF_ACCOUNTS_CATALOG.length);
    expect(prisma.chartOfAccount.create).not.toHaveBeenCalled();
    expect(prisma.chartOfAccount.update.mock.calls.length).toBe(CHART_OF_ACCOUNTS_CATALOG.length);

    // Ids stable across re-runs (critical — journal_lines reference id).
    for (const row of prisma.rows) {
      expect(row.id).toBe(idsBefore.get(row.code));
    }
  });

  it('mirrors PDD Appendix A by including the Cash, Deferred Revenue, Subscription Revenue, Marketplace Revenue, Provider Payable, and Coupon Discount accounts that journal entries reference', async () => {
    const prisma = new FakePrisma();
    await seedChartOfAccounts(prisma as unknown as PrismaService);
    const codes = new Set(prisma.rows.map((r) => r.code));

    expect(codes.has('1000'), 'Cash').toBe(true);
    expect(codes.has('2000'), 'Deferred Revenue').toBe(true);
    expect(codes.has('2100'), 'Provider Payable').toBe(true);
    expect(codes.has('4000'), 'Subscription Revenue').toBe(true);
    expect(codes.has('4100'), 'Marketplace Revenue').toBe(true);
    expect(codes.has('4500'), 'Marketplace Revenue Contra').toBe(true);
    expect(codes.has('4510'), 'Coupon Discount').toBe(true);
    expect(codes.has('4520'), 'Refunds').toBe(true);
  });

  it('seats correct normal_balance on contra-revenue accounts (debit, not credit)', async () => {
    const prisma = new FakePrisma();
    await seedChartOfAccounts(prisma as unknown as PrismaService);

    for (const entry of CHART_OF_ACCOUNTS_CATALOG.filter((e) => e.type === 'contra_revenue')) {
      const row = prisma.rows.find((r) => r.code === entry.code);
      expect(
        row?.normalBalance,
        `contra-revenue ${entry.code} must have normal_balance=debit`,
      ).toBe('debit');
    }
  });

  it('seats every parent account before its children (single-pass insert contract)', async () => {
    const prisma = new FakePrisma();
    await seedChartOfAccounts(prisma as unknown as PrismaService);

    const insertOrder = prisma.rows.map((r) => r.code);
    for (const entry of CHART_OF_ACCOUNTS_CATALOG) {
      if (entry.parentCode === null) continue;
      const parentIdx = insertOrder.indexOf(entry.parentCode);
      const childIdx = insertOrder.indexOf(entry.code);
      expect(
        parentIdx,
        `parent ${entry.parentCode} missing when ${entry.code} was inserted`,
      ).toBeGreaterThan(-1);
      expect(parentIdx).toBeLessThan(childIdx);
    }
  });

  it('refreshes mutable columns on update (name + description + active) but never overwrites the id', async () => {
    const prisma = new FakePrisma();
    await seedChartOfAccounts(prisma as unknown as PrismaService);
    const cash = prisma.rows.find((r) => r.code === '1000')!;
    const originalId = cash.id;

    // Simulate an ops edit that changed the description in-database.
    cash.description = 'human-edited description';
    cash.active = false;

    await seedChartOfAccounts(prisma as unknown as PrismaService);

    const refreshed = prisma.rows.find((r) => r.code === '1000')!;
    expect(refreshed.id).toBe(originalId);
    // The seed overwrites the catalog-owned columns back to canonical.
    expect(refreshed.description).toBe(
      CHART_OF_ACCOUNTS_CATALOG.find((e) => e.code === '1000')!.description,
    );
    expect(refreshed.active).toBe(true);
  });
});
