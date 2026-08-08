import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { TrialBalanceService } from './trial-balance.service';

function decimal(value: string): { toString(): string } {
  return { toString: () => value };
}

interface AggRow {
  readonly accountId: string;
  readonly _sum: {
    readonly debit: { toString(): string } | null;
    readonly credit: { toString(): string } | null;
  };
}

interface MetaRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: 'asset' | 'liability' | 'equity' | 'revenue' | 'contra_revenue' | 'expense';
  readonly normalBalance: 'debit' | 'credit';
}

function buildPrismaStub(opts: {
  journalLineGroupBy?: (args: unknown) => Promise<AggRow[]>;
  chartOfAccountFindMany?: (args: unknown) => Promise<MetaRow[]>;
  periodFindUnique?: (args: unknown) => Promise<{ id: string; name: string } | null>;
}): PrismaService {
  return {
    journalLine: {
      groupBy: vi.fn(opts.journalLineGroupBy ?? (async () => [])),
    },
    chartOfAccount: {
      findMany: vi.fn(opts.chartOfAccountFindMany ?? (async () => [])),
    },
    accountingPeriod: {
      findUnique: vi.fn(opts.periodFindUnique ?? (async () => null)),
    },
  } as unknown as PrismaService;
}

const cashMeta: MetaRow = {
  id: 'acc_cash',
  code: '1000',
  name: 'Cash',
  type: 'asset',
  normalBalance: 'debit',
};

const deferredMeta: MetaRow = {
  id: 'acc_def',
  code: '2000.family.tier2',
  name: 'Deferred Revenue T2',
  type: 'liability',
  normalBalance: 'credit',
};

const revenueMeta: MetaRow = {
  id: 'acc_rev',
  code: '4000.family.tier2',
  name: 'Subscription Revenue T2',
  type: 'revenue',
  normalBalance: 'credit',
};

describe('TrialBalanceService.compute', () => {
  it('returns an empty rows + zero totals when chart of accounts is empty', async () => {
    const prisma = buildPrismaStub({
      journalLineGroupBy: async () => [],
      chartOfAccountFindMany: async () => [],
    });
    const service = new TrialBalanceService(prisma);
    const result = await service.compute({});
    expect(result.rows).toEqual([]);
    expect(result.totalDebitMinor).toBe(0);
    expect(result.totalCreditMinor).toBe(0);
    expect(result.imbalanceMinor).toBe(0);
    expect(result.currency).toBe('USD');
    expect(result.periodId).toBeNull();
    expect(result.periodName).toBeNull();
  });

  it('aggregates a single balanced activation journal across cash + deferred', async () => {
    const prisma = buildPrismaStub({
      journalLineGroupBy: async () => [
        { accountId: 'acc_cash', _sum: { debit: decimal('299.00'), credit: decimal('0') } },
        { accountId: 'acc_def', _sum: { debit: decimal('0'), credit: decimal('299.00') } },
      ],
      chartOfAccountFindMany: async () => [cashMeta, deferredMeta],
    });
    const service = new TrialBalanceService(prisma);
    const result = await service.compute({});
    expect(result.rows).toHaveLength(2);
    expect(result.totalDebitMinor).toBe(29_900);
    expect(result.totalCreditMinor).toBe(29_900);
    expect(result.imbalanceMinor).toBe(0);

    const cashRow = result.rows.find((r) => r.accountCode === '1000');
    expect(cashRow?.debitTotalMinor).toBe(29_900);
    expect(cashRow?.netDebitMinor).toBe(29_900);
    expect(cashRow?.netCreditMinor).toBe(0);

    const defRow = result.rows.find((r) => r.accountCode === '2000.family.tier2');
    expect(defRow?.creditTotalMinor).toBe(29_900);
    expect(defRow?.netCreditMinor).toBe(29_900);
    expect(defRow?.netDebitMinor).toBe(0);
  });

  it('orders rows by accountType then accountCode', async () => {
    const prisma = buildPrismaStub({
      journalLineGroupBy: async () => [],
      chartOfAccountFindMany: async () => [revenueMeta, cashMeta, deferredMeta],
    });
    const service = new TrialBalanceService(prisma);
    const result = await service.compute({});
    expect(result.rows.map((r) => r.accountType)).toEqual(['asset', 'liability', 'revenue']);
  });

  it('zero-balance active rows still appear on the report', async () => {
    const prisma = buildPrismaStub({
      journalLineGroupBy: async () => [], // no activity
      chartOfAccountFindMany: async () => [cashMeta], // but the account is active
    });
    const service = new TrialBalanceService(prisma);
    const result = await service.compute({});
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.debitTotalMinor).toBe(0);
    expect(result.rows[0]?.netDebitMinor).toBe(0);
    expect(result.rows[0]?.netCreditMinor).toBe(0);
  });

  it('reports an imbalance when totals diverge', async () => {
    const prisma = buildPrismaStub({
      journalLineGroupBy: async () => [
        { accountId: 'acc_cash', _sum: { debit: decimal('100.00'), credit: decimal('0') } },
        { accountId: 'acc_def', _sum: { debit: decimal('0'), credit: decimal('99.00') } },
      ],
      chartOfAccountFindMany: async () => [cashMeta, deferredMeta],
    });
    const service = new TrialBalanceService(prisma);
    const result = await service.compute({});
    expect(result.totalDebitMinor).toBe(10_000);
    expect(result.totalCreditMinor).toBe(9_900);
    expect(result.imbalanceMinor).toBe(100);
  });

  it('resolves periodName to periodId before filtering', async () => {
    const groupBy = vi.fn(async (_args: unknown): Promise<AggRow[]> => []);
    const periodFindUnique = vi.fn(async () => ({ id: 'per_x', name: '2026-05' }));
    const prisma = buildPrismaStub({
      journalLineGroupBy: groupBy,
      chartOfAccountFindMany: async () => [],
      periodFindUnique,
    });
    const service = new TrialBalanceService(prisma);
    const result = await service.compute({ periodName: '2026-05' });
    expect(result.periodId).toBe('per_x');
    expect(result.periodName).toBe('2026-05');
    const callArgs = groupBy.mock.calls.at(0)?.[0] as {
      where: { journal?: { periodId?: string } };
    };
    expect(callArgs.where.journal?.periodId).toBe('per_x');
  });

  it('returns empty rows + echoes periodName when period is unknown', async () => {
    const prisma = buildPrismaStub({
      periodFindUnique: async () => null,
    });
    const service = new TrialBalanceService(prisma);
    const result = await service.compute({ periodName: '1999-01' });
    expect(result.rows).toEqual([]);
    expect(result.totalDebitMinor).toBe(0);
    expect(result.totalCreditMinor).toBe(0);
    expect(result.periodId).toBeNull();
    expect(result.periodName).toBe('1999-01');
  });

  it('uses periodId when both are provided', async () => {
    const groupBy = vi.fn(async (_args: unknown): Promise<AggRow[]> => []);
    const periodFindUnique = vi.fn(async (args: unknown) => {
      const where = (args as { where: { id?: string } }).where;
      return where.id !== undefined ? { id: where.id, name: '2026-05' } : null;
    });
    const prisma = buildPrismaStub({
      journalLineGroupBy: groupBy,
      chartOfAccountFindMany: async () => [],
      periodFindUnique,
    });
    const service = new TrialBalanceService(prisma);
    await service.compute({ periodId: 'per_winner', periodName: '2026-05' });
    expect(periodFindUnique).toHaveBeenCalledWith({
      where: { id: 'per_winner' },
      select: { id: true, name: true },
    });
  });

  it('filters journalLine.groupBy by currency', async () => {
    const groupBy = vi.fn(async (_args: unknown): Promise<AggRow[]> => []);
    const prisma = buildPrismaStub({
      journalLineGroupBy: groupBy,
      chartOfAccountFindMany: async () => [],
    });
    const service = new TrialBalanceService(prisma);
    await service.compute({ currency: 'USD' });
    const callArgs = groupBy.mock.calls.at(0)?.[0] as {
      where: { currency?: string };
    };
    expect(callArgs.where.currency).toBe('USD');
  });
});
