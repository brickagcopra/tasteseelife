import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { AdminChartOfAccountsService } from './admin-chart-of-accounts.service';

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

interface FindUniqueArgs {
  where: { id: string };
  select: Record<string, true>;
}

interface UpdateArgs {
  where: { id: string };
  data: { active: boolean };
  select: Record<string, true>;
}

class FakePrisma {
  public rows: FakeAccountRow[] = [];
  public lastFindUnique: FindUniqueArgs | null = null;
  public lastUpdate: UpdateArgs | null = null;
  public updateCount = 0;

  chartOfAccount = {
    findUnique: vi.fn(async (args: FindUniqueArgs): Promise<FakeAccountRow | null> => {
      this.lastFindUnique = args;
      return this.rows.find((r) => r.id === args.where.id) ?? null;
    }),
    update: vi.fn(async (args: UpdateArgs): Promise<FakeAccountRow> => {
      this.lastUpdate = args;
      this.updateCount += 1;
      const idx = this.rows.findIndex((r) => r.id === args.where.id);
      if (idx === -1) {
        throw new Error(`fake prisma: account ${args.where.id} not found`);
      }
      const row = this.rows[idx]!;
      const updated: FakeAccountRow = {
        ...row,
        active: args.data.active,
        updatedAt: new Date('2026-05-18T12:34:56.000Z'),
      };
      this.rows[idx] = updated;
      return updated;
    }),
  };

  // Minimal $transaction shim that just invokes the callback with `this`
  // as the tx client.
  $transaction = vi.fn(async <T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> => {
    return fn(this);
  });
}

function buildSvc(): {
  service: AdminChartOfAccountsService;
  prisma: FakePrisma;
} {
  const prisma = new FakePrisma();
  const service = new AdminChartOfAccountsService(prisma as unknown as PrismaService);
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

describe('AdminChartOfAccountsService.setActive', () => {
  const NOW = new Date('2026-05-18T12:00:00.000Z');

  it('returns account_not_found when the id does not resolve', async () => {
    const { service } = buildSvc();
    const result = await service.setActive({
      accountId: 'coa_missing',
      active: false,
      reason: 'chart_cleanup',
      note: null,
      actorUserId: 'usr_admin',
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('account_not_found');
    }
  });

  it('retires an active account (true → false)', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ id: 'coa_cash', active: true }));

    const result = await service.setActive({
      accountId: 'coa_cash',
      active: false,
      reason: 'chart_cleanup',
      note: 'Replaced by 1000.cash.stripe.',
      actorUserId: 'usr_admin',
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.before).toEqual({ active: true });
      expect(result.value.after).toEqual({ active: false });
      expect(result.value.account.id).toBe('coa_cash');
      expect(result.value.account.active).toBe(false);
      expect(result.value.performedAt).toEqual(NOW);
    }
    expect(prisma.updateCount).toBe(1);
    expect(prisma.lastUpdate?.data.active).toBe(false);
  });

  it('activates a retired account (false → true)', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ id: 'coa_retired', active: false }));

    const result = await service.setActive({
      accountId: 'coa_retired',
      active: true,
      reason: 'restore',
      note: null,
      actorUserId: 'usr_admin',
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.before).toEqual({ active: false });
      expect(result.value.after).toEqual({ active: true });
      expect(result.value.account.active).toBe(true);
    }
  });

  it('treats a toggle-to-current-state as a no-op success (idempotent)', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ id: 'coa_cash', active: true }));

    const result = await service.setActive({
      accountId: 'coa_cash',
      active: true,
      reason: 'restore',
      note: null,
      actorUserId: 'usr_admin',
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.before).toEqual({ active: true });
      expect(result.value.after).toEqual({ active: true });
    }
    // Write still runs — the audit log records the action even when
    // the business state is unchanged.
    expect(prisma.updateCount).toBe(1);
  });

  it('surfaces unsupported_currency when the persisted row carries a non-USD currency', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ id: 'coa_eur', currency: 'EUR' }));

    const result = await service.setActive({
      accountId: 'coa_eur',
      active: false,
      reason: 'other',
      note: null,
      actorUserId: 'usr_admin',
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('unsupported_currency');
    }
  });

  it('passes through the optional description field on the projected account', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ id: 'coa_cash', description: 'Operating bank.' }));

    const result = await service.setActive({
      accountId: 'coa_cash',
      active: false,
      reason: 'chart_cleanup',
      note: null,
      actorUserId: 'usr_admin',
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.account.description).toBe('Operating bank.');
    }
  });

  it('handles a null description (omits no special wire shape on the row)', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ id: 'coa_no_desc', description: null }));

    const result = await service.setActive({
      accountId: 'coa_no_desc',
      active: false,
      reason: 'chart_cleanup',
      note: null,
      actorUserId: 'usr_admin',
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.account.description).toBeNull();
    }
  });

  it('uses an explicit projection on findUnique (no SELECT *)', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ id: 'coa_cash' }));
    await service.setActive({
      accountId: 'coa_cash',
      active: false,
      reason: 'chart_cleanup',
      note: null,
      actorUserId: 'usr_admin',
      now: NOW,
    });
    expect(prisma.lastFindUnique?.select).toBeTruthy();
    expect(prisma.lastFindUnique?.select?.['active']).toBe(true);
    expect(prisma.lastFindUnique?.select?.['id']).toBe(true);
  });

  it('uses an explicit projection on update (no SELECT *)', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ id: 'coa_cash' }));
    await service.setActive({
      accountId: 'coa_cash',
      active: false,
      reason: 'chart_cleanup',
      note: null,
      actorUserId: 'usr_admin',
      now: NOW,
    });
    expect(prisma.lastUpdate?.select).toBeTruthy();
    // Spot-check: the projection includes the columns the response shape needs.
    expect(prisma.lastUpdate?.select?.['code']).toBe(true);
    expect(prisma.lastUpdate?.select?.['type']).toBe(true);
    expect(prisma.lastUpdate?.select?.['normalBalance']).toBe(true);
    expect(prisma.lastUpdate?.select?.['currency']).toBe(true);
    expect(prisma.lastUpdate?.select?.['active']).toBe(true);
  });

  it('uses the current Date when `now` is omitted', async () => {
    const { service, prisma } = buildSvc();
    prisma.rows.push(buildRow({ id: 'coa_cash' }));

    const before = Date.now();
    const result = await service.setActive({
      accountId: 'coa_cash',
      active: false,
      reason: 'chart_cleanup',
      note: null,
      actorUserId: 'usr_admin',
    });
    const after = Date.now();

    expect(result.ok).toBe(true);
    if (result.ok) {
      const ts = result.value.performedAt.getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    }
  });
});
