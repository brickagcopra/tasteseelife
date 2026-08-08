import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { AccountingPeriodService } from './accounting-period.service';
import { JournalPostingService } from './journal-posting.service';

/**
 * In-memory Prisma stand-in covering exactly the surface the
 * journal-posting + accounting-period services touch.
 *
 * Persistence model:
 *   - `chartOfAccount` rows seeded by the test setup with id + code + active.
 *   - `accountingPeriod` rows keyed by `name` (UNIQUE).
 *   - `journal` rows keyed by `id`; UNIQUE on `sourceEventId`.
 *   - `journalLine` rows associated to journals.
 *
 * `$transaction(callback)` runs the callback against the same fake
 * — single-test isolation so we don't need rollback fidelity; the
 * Testcontainers integration test (TS-080-followup-5) covers the
 * real Postgres transaction interleaving.
 */

interface FakeChartRow {
  id: string;
  code: string;
  active: boolean;
}

interface FakeAccountingPeriodRow {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  status: 'open' | 'closed';
}

interface FakeJournalRow {
  id: string;
  kind: string;
  occurredAt: Date;
  postedAt: Date;
  sourceEventId: string;
  description: string;
  periodId: string;
  postedByUserId: string | null;
  reversedJournalId: string | null;
  reversedByJournalId: string | null;
  context: Record<string, unknown>;
}

interface FakeJournalLineRow {
  id: string;
  journalId: string;
  accountId: string;
  debit: Decimal;
  credit: Decimal;
  currency: string;
  memo: string | null;
  createdAt: Date;
}

class PrismaUniqueViolation extends Error {
  public readonly code = 'P2002';
  public readonly meta: { target: string[] };
  constructor(target: string[]) {
    super('Unique constraint failed');
    this.name = 'PrismaClientKnownRequestError';
    this.meta = { target };
  }
}

class FakePrisma {
  public chartRows: FakeChartRow[] = [];
  public periodRows: FakeAccountingPeriodRow[] = [];
  public journalRows: FakeJournalRow[] = [];
  public lineRows: FakeJournalLineRow[] = [];
  private autoId = 0;

  seedAccount(code: string, options: { active?: boolean } = {}): string {
    this.autoId += 1;
    const id = `coa_${code.replace(/[^a-z0-9]/g, '_')}_${this.autoId}`;
    this.chartRows.push({
      id,
      code,
      active: options.active ?? true,
    });
    return id;
  }

  seedPeriod(name: string, status: 'open' | 'closed' = 'open'): FakeAccountingPeriodRow {
    const [year, month] = name.split('-').map(Number);
    if (year === undefined || month === undefined) {
      throw new Error(`bad period name: ${name}`);
    }
    this.autoId += 1;
    const row: FakeAccountingPeriodRow = {
      id: `prd_${name}_${this.autoId}`,
      name,
      startDate: new Date(Date.UTC(year, month - 1, 1)),
      endDate: new Date(Date.UTC(year, month, 0)),
      status,
    };
    this.periodRows.push(row);
    return row;
  }

  chartOfAccount = {
    findMany: async (args: {
      where: { code: { in: string[] } };
      select: { id: true; code: true; active: true };
    }): Promise<FakeChartRow[]> => {
      const codes = new Set(args.where.code.in);
      return this.chartRows.filter((row) => codes.has(row.code));
    },
  };

  accountingPeriod = {
    findUnique: async (args: {
      where: { name: string };
      select: { id: true; name: true; status: true };
    }): Promise<{ id: string; name: string; status: 'open' | 'closed' } | null> => {
      const row = this.periodRows.find((r) => r.name === args.where.name);
      return row === undefined ? null : { id: row.id, name: row.name, status: row.status };
    },
    create: async (args: {
      data: {
        name: string;
        startDate: Date;
        endDate: Date;
        status: 'open' | 'closed';
      };
      select: { id: true; name: true; status: true };
    }): Promise<{ id: string; name: string; status: 'open' | 'closed' }> => {
      if (this.periodRows.some((r) => r.name === args.data.name)) {
        throw new PrismaUniqueViolation(['name']);
      }
      this.autoId += 1;
      const row: FakeAccountingPeriodRow = {
        id: `prd_${args.data.name}_${this.autoId}`,
        name: args.data.name,
        startDate: args.data.startDate,
        endDate: args.data.endDate,
        status: args.data.status,
      };
      this.periodRows.push(row);
      return { id: row.id, name: row.name, status: row.status };
    },
  };

  journal = {
    create: async (args: {
      data: JournalCreateInput;
      select: unknown;
    }): Promise<FakeJournalWithLines> => {
      if (this.journalRows.some((r) => r.sourceEventId === args.data.sourceEventId)) {
        throw new PrismaUniqueViolation(['source_event_id']);
      }
      this.autoId += 1;
      const journal: FakeJournalRow = {
        id: `jrnl_${this.autoId}`,
        kind: args.data.kind,
        occurredAt: args.data.occurredAt,
        postedAt: new Date('2026-05-13T00:00:00.000Z'),
        sourceEventId: args.data.sourceEventId,
        description: args.data.description,
        periodId: args.data.periodId,
        postedByUserId: args.data.postedByUserId,
        reversedJournalId: args.data.reversedJournalId,
        reversedByJournalId: null,
        context: args.data.context,
      };
      this.journalRows.push(journal);

      const lineRows: FakeJournalLineRow[] = [];
      let lineIdx = 0;
      for (const input of args.data.lines.create) {
        this.autoId += 1;
        const line: FakeJournalLineRow = {
          id: `jl_${this.autoId}_${lineIdx}`,
          journalId: journal.id,
          accountId: input.accountId,
          debit: ensureDecimal(input.debit),
          credit: ensureDecimal(input.credit),
          currency: input.currency,
          memo: input.memo,
          createdAt: new Date(Date.now() + lineIdx),
        };
        this.lineRows.push(line);
        lineRows.push(line);
        lineIdx += 1;
      }

      return this.buildJournalWithLines(journal, lineRows);
    },
    findUnique: async (args: {
      where: { id?: string; sourceEventId?: string };
      select: unknown;
    }): Promise<FakeJournalWithLines | null> => {
      const row = this.journalRows.find((r) =>
        args.where.id !== undefined
          ? r.id === args.where.id
          : r.sourceEventId === args.where.sourceEventId,
      );
      if (row === undefined) return null;
      const lines = this.lineRows.filter((l) => l.journalId === row.id);
      return this.buildJournalWithLines(row, lines);
    },
    update: async (args: {
      where: { id: string };
      data: { reversedByJournalId: string };
    }): Promise<{ id: string }> => {
      const row = this.journalRows.find((r) => r.id === args.where.id);
      if (row === undefined) {
        throw new Error(`fake.journal.update: row not found id=${args.where.id}`);
      }
      row.reversedByJournalId = args.data.reversedByJournalId;
      return { id: row.id };
    },
  };

  async $transaction<T>(callback: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return callback(this);
  }

  private buildJournalWithLines(
    row: FakeJournalRow,
    lines: FakeJournalLineRow[],
  ): FakeJournalWithLines {
    const period = this.periodRows.find((p) => p.id === row.periodId);
    if (period === undefined) {
      throw new Error(`fake.buildJournalWithLines: missing period ${row.periodId}`);
    }
    return {
      id: row.id,
      kind: row.kind,
      occurredAt: row.occurredAt,
      postedAt: row.postedAt,
      sourceEventId: row.sourceEventId,
      description: row.description,
      periodId: row.periodId,
      period: { id: period.id, name: period.name, status: period.status },
      postedByUserId: row.postedByUserId,
      reversedJournalId: row.reversedJournalId,
      reversedByJournalId: row.reversedByJournalId,
      context: row.context,
      lines: lines
        .slice()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((line) => ({
          id: line.id,
          accountId: line.accountId,
          debit: line.debit,
          credit: line.credit,
          currency: line.currency,
          memo: line.memo,
          account: {
            code: this.chartRows.find((c) => c.id === line.accountId)?.code ?? '',
          },
        })),
    };
  }
}

interface JournalCreateInput {
  kind: string;
  occurredAt: Date;
  sourceEventId: string;
  description: string;
  periodId: string;
  postedByUserId: string | null;
  reversedJournalId: string | null;
  context: Record<string, unknown>;
  lines: {
    create: Array<{
      accountId: string;
      debit: unknown;
      credit: unknown;
      currency: string;
      memo: string | null;
    }>;
  };
}

interface FakeJournalWithLines {
  id: string;
  kind: string;
  occurredAt: Date;
  postedAt: Date;
  sourceEventId: string;
  description: string;
  periodId: string;
  period: { id: string; name: string; status: string };
  postedByUserId: string | null;
  reversedJournalId: string | null;
  reversedByJournalId: string | null;
  context: Record<string, unknown>;
  lines: Array<{
    id: string;
    accountId: string;
    debit: Decimal;
    credit: Decimal;
    currency: string;
    memo: string | null;
    account: { code: string };
  }>;
}

function ensureDecimal(value: unknown): Decimal {
  if (value instanceof Decimal) return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    'toString' in value &&
    typeof (value as { toString(): string }).toString === 'function'
  ) {
    return new Decimal((value as { toString(): string }).toString());
  }
  return new Decimal(String(value));
}

function buildService(fake: FakePrisma): JournalPostingService {
  const periods = new AccountingPeriodService();
  return new JournalPostingService(fake as unknown as PrismaService, periods);
}

const occurredAt = '2026-05-13T00:00:00.000Z';

describe('JournalPostingService.post', () => {
  let fake: FakePrisma;
  let service: JournalPostingService;
  let cashId: string;
  let deferredTier2Id: string;
  let providerPayableId: string;

  beforeEach(() => {
    fake = new FakePrisma();
    cashId = fake.seedAccount('1000');
    deferredTier2Id = fake.seedAccount('2000.family.tier2');
    providerPayableId = fake.seedAccount('2100');
    service = buildService(fake);
  });

  it('posts a balanced two-line journal and returns the response DTO', async () => {
    const result = await service.post(
      {
        kind: 'subscription_activation',
        occurredAt,
        sourceEventId: 'evt_sub_activated_abc',
        description: 'Tier 2 subscription activated.',
        lines: [
          { accountCode: '1000', debitMinor: 29_900, currency: 'USD' },
          { accountCode: '2000.family.tier2', creditMinor: 29_900, currency: 'USD' },
        ],
      },
      null,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('subscription_activation');
    expect(result.value.sourceEventId).toBe('evt_sub_activated_abc');
    expect(result.value.periodName).toBe('2026-05');
    expect(result.value.lines).toHaveLength(2);
    expect(result.value.lines[0]?.debitMinor).toBe(29_900);
    expect(result.value.lines[0]?.creditMinor).toBe(0);
    expect(result.value.lines[0]?.accountCode).toBe('1000');
    expect(result.value.lines[0]?.accountId).toBe(cashId);
    expect(result.value.lines[1]?.creditMinor).toBe(29_900);
    expect(result.value.lines[1]?.accountId).toBe(deferredTier2Id);
    expect(result.value.postedByUserId).toBeNull();
    expect(result.value.reversedJournalId).toBeNull();
    expect(result.value.reversedByJournalId).toBeNull();
  });

  it('accepts a balanced four-line journal (booking completion shape)', async () => {
    const marketplaceRevenueId = fake.seedAccount('4100');
    const marketplaceContraId = fake.seedAccount('4500');
    const _bookingPath = [cashId, marketplaceRevenueId, marketplaceContraId, providerPayableId];
    expect(_bookingPath).toHaveLength(4);

    const result = await service.post(
      {
        kind: 'booking_completion',
        occurredAt,
        sourceEventId: 'evt_booking_completed_xyz',
        description: 'Booking $150 completed; provider portion $120.',
        lines: [
          // Gross commission
          { accountCode: '1000', debitMinor: 15_000, currency: 'USD' },
          { accountCode: '4100', creditMinor: 15_000, currency: 'USD' },
          // Provider portion contra
          { accountCode: '4500', debitMinor: 12_000, currency: 'USD' },
          { accountCode: '2100', creditMinor: 12_000, currency: 'USD' },
        ],
      },
      null,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines).toHaveLength(4);
    // The journal balances at $15000 + $12000 debit vs the same in credit.
    const totalDebit = result.value.lines.reduce((s, l) => s + l.debitMinor, 0);
    const totalCredit = result.value.lines.reduce((s, l) => s + l.creditMinor, 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(27_000);
  });

  it('rejects an unbalanced journal with `journal_unbalanced`', async () => {
    const result = await service.post(
      {
        kind: 'subscription_activation',
        occurredAt,
        sourceEventId: 'evt_unbalanced_abc',
        description: 'Off by 100 cents.',
        lines: [
          { accountCode: '1000', debitMinor: 29_900, currency: 'USD' },
          { accountCode: '2000.family.tier2', creditMinor: 29_800, currency: 'USD' },
        ],
      },
      null,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('journal_unbalanced');
    if (result.failure.kind !== 'journal_unbalanced') return;
    expect(result.failure.debitTotalMinor).toBe(29_900);
    expect(result.failure.creditTotalMinor).toBe(29_800);
    // The transaction was aborted — no journal row should exist.
    expect(fake.journalRows).toHaveLength(0);
  });

  it('rejects an unknown account code with `account_not_found`', async () => {
    const result = await service.post(
      {
        kind: 'manual_adjustment',
        occurredAt,
        sourceEventId: 'evt_unknown_account',
        description: 'References a missing account.',
        lines: [
          { accountCode: '9999', debitMinor: 100, currency: 'USD' },
          { accountCode: '1000', creditMinor: 100, currency: 'USD' },
        ],
      },
      null,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('account_not_found');
    if (result.failure.kind !== 'account_not_found') return;
    expect(result.failure.accountCode).toBe('9999');
    expect(fake.journalRows).toHaveLength(0);
  });

  it('rejects an inactive account with `account_inactive`', async () => {
    const retiredId = fake.seedAccount('4099', { active: false });
    expect(retiredId).toBeDefined();

    const result = await service.post(
      {
        kind: 'manual_adjustment',
        occurredAt,
        sourceEventId: 'evt_inactive_account',
        description: 'References a retired account.',
        lines: [
          { accountCode: '4099', debitMinor: 100, currency: 'USD' },
          { accountCode: '1000', creditMinor: 100, currency: 'USD' },
        ],
      },
      null,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('account_inactive');
    expect(fake.journalRows).toHaveLength(0);
  });

  it('rejects posts to a closed period with `period_closed`', async () => {
    fake.seedPeriod('2026-05', 'closed');
    const result = await service.post(
      {
        kind: 'subscription_activation',
        occurredAt,
        sourceEventId: 'evt_closed_period',
        description: 'Closed period post.',
        lines: [
          { accountCode: '1000', debitMinor: 100, currency: 'USD' },
          { accountCode: '2000.family.tier2', creditMinor: 100, currency: 'USD' },
        ],
      },
      null,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('period_closed');
    if (result.failure.kind !== 'period_closed') return;
    expect(result.failure.periodName).toBe('2026-05');
    expect(fake.journalRows).toHaveLength(0);
  });

  it('lazy-creates a monthly period on the first post in that month', async () => {
    expect(fake.periodRows).toHaveLength(0);
    const result = await service.post(
      {
        kind: 'subscription_activation',
        occurredAt,
        sourceEventId: 'evt_lazy_create',
        description: 'First post in May.',
        lines: [
          { accountCode: '1000', debitMinor: 100, currency: 'USD' },
          { accountCode: '2000.family.tier2', creditMinor: 100, currency: 'USD' },
        ],
      },
      null,
    );

    expect(result.ok).toBe(true);
    expect(fake.periodRows).toHaveLength(1);
    expect(fake.periodRows[0]?.name).toBe('2026-05');
    expect(fake.periodRows[0]?.status).toBe('open');
  });

  it('reuses an existing period on subsequent posts in the same month', async () => {
    await service.post(
      {
        kind: 'subscription_activation',
        occurredAt,
        sourceEventId: 'evt_first_in_may',
        description: 'first',
        lines: [
          { accountCode: '1000', debitMinor: 100, currency: 'USD' },
          { accountCode: '2000.family.tier2', creditMinor: 100, currency: 'USD' },
        ],
      },
      null,
    );
    await service.post(
      {
        kind: 'subscription_activation',
        occurredAt: '2026-05-20T00:00:00.000Z',
        sourceEventId: 'evt_second_in_may',
        description: 'second',
        lines: [
          { accountCode: '1000', debitMinor: 200, currency: 'USD' },
          { accountCode: '2000.family.tier2', creditMinor: 200, currency: 'USD' },
        ],
      },
      null,
    );

    expect(fake.periodRows).toHaveLength(1);
    expect(fake.journalRows).toHaveLength(2);
  });

  it('idempotently replays on a duplicate sourceEventId', async () => {
    const first = await service.post(
      {
        kind: 'subscription_activation',
        occurredAt,
        sourceEventId: 'evt_replayable',
        description: 'first attempt',
        lines: [
          { accountCode: '1000', debitMinor: 29_900, currency: 'USD' },
          { accountCode: '2000.family.tier2', creditMinor: 29_900, currency: 'USD' },
        ],
      },
      null,
    );
    expect(first.ok).toBe(true);

    const replay = await service.post(
      {
        kind: 'subscription_activation',
        occurredAt,
        // The same source event id — the at-least-once relay redelivered.
        sourceEventId: 'evt_replayable',
        description: 'second attempt (redelivered)',
        lines: [
          { accountCode: '1000', debitMinor: 29_900, currency: 'USD' },
          { accountCode: '2000.family.tier2', creditMinor: 29_900, currency: 'USD' },
        ],
      },
      null,
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok || !first.ok) return;
    // The replay returned the existing (first) journal id, not a new row.
    expect(replay.value.id).toBe(first.value.id);
    expect(fake.journalRows).toHaveLength(1);
  });

  it('rejects mixed currencies on a single journal', async () => {
    const result = await service.post(
      {
        kind: 'subscription_activation',
        occurredAt,
        sourceEventId: 'evt_mixed_currency',
        description: 'Mixed currency journal.',
        // The contract layer doesn't (yet) catch this — the union is
        // typed at the contract level as USD-only, but the service-
        // layer check defends future multi-currency expansion.
        lines: [
          { accountCode: '1000', debitMinor: 100, currency: 'USD' },
          {
            accountCode: '2000.family.tier2',
            creditMinor: 100,
            currency: 'EUR' as 'USD',
          },
        ],
      },
      null,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('mixed_currency');
  });

  it('records postedByUserId for non-system journals', async () => {
    const result = await service.post(
      {
        kind: 'manual_adjustment',
        occurredAt,
        sourceEventId: 'evt_admin_post',
        description: 'Manual posting by admin.',
        lines: [
          { accountCode: '1000', debitMinor: 100, currency: 'USD' },
          { accountCode: '2000.family.tier2', creditMinor: 100, currency: 'USD' },
        ],
      },
      'usr_admin_alice',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.postedByUserId).toBe('usr_admin_alice');
  });

  it('preserves the wire-shape integer cents through the Decimal round-trip', async () => {
    // Spot-check several cent precisions to verify the conversion
    // is exact (no float drift). Each line pair is balanced.
    const cases = [1, 99, 100, 12_345, 99_999_999];
    for (const minor of cases) {
      const result = await service.post(
        {
          kind: 'subscription_activation',
          occurredAt,
          sourceEventId: `evt_precision_${minor}`,
          description: `precision case ${minor}`,
          lines: [
            { accountCode: '1000', debitMinor: minor, currency: 'USD' },
            { accountCode: '2000.family.tier2', creditMinor: minor, currency: 'USD' },
          ],
        },
        null,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.lines[0]?.debitMinor).toBe(minor);
      expect(result.value.lines[1]?.creditMinor).toBe(minor);
    }
  });

  it('handles duplicate account codes within one journal (e.g. two debits to Cash)', async () => {
    // Cash is debited twice for different reasons; the credit
    // offsets the sum. This is a legal accounting shape.
    const result = await service.post(
      {
        kind: 'manual_adjustment',
        occurredAt,
        sourceEventId: 'evt_dup_account_codes',
        description: 'Two debits to Cash + single offset.',
        lines: [
          {
            accountCode: '1000',
            debitMinor: 100,
            currency: 'USD',
            memo: 'partial 1',
          },
          {
            accountCode: '1000',
            debitMinor: 200,
            currency: 'USD',
            memo: 'partial 2',
          },
          {
            accountCode: '2000.family.tier2',
            creditMinor: 300,
            currency: 'USD',
          },
        ],
      },
      'usr_admin_alice',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines).toHaveLength(3);
    expect(result.value.lines[0]?.accountId).toBe(cashId);
    expect(result.value.lines[1]?.accountId).toBe(cashId);
  });
});

describe('JournalPostingService.postManualAdjustment', () => {
  let fake: FakePrisma;
  let service: JournalPostingService;

  beforeEach(() => {
    fake = new FakePrisma();
    fake.seedAccount('1000');
    fake.seedAccount('4520'); // Refunds contra-revenue
    service = buildService(fake);
  });

  it('locks kind to `manual_adjustment` and weaves the reason code into context', async () => {
    const result = await service.postManualAdjustment(
      {
        occurredAt,
        sourceEventId: 'manual_adj_2026_05_13_001',
        description: 'Off-platform refund cleared by check.',
        reasonCode: 'OFF_PLATFORM_REFUND',
        lines: [
          { accountCode: '4520', debitMinor: 9_900, currency: 'USD' },
          { accountCode: '1000', creditMinor: 9_900, currency: 'USD' },
        ],
      },
      'usr_admin_finance',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('manual_adjustment');
    expect(result.value.context['reasonCode']).toBe('OFF_PLATFORM_REFUND');
    expect(result.value.postedByUserId).toBe('usr_admin_finance');
  });
});

describe('JournalPostingService.reverse', () => {
  let fake: FakePrisma;
  let service: JournalPostingService;
  let originalId: string;

  beforeEach(async () => {
    fake = new FakePrisma();
    fake.seedAccount('1000');
    fake.seedAccount('2000.family.tier2');
    service = buildService(fake);
    const post = await service.post(
      {
        kind: 'subscription_activation',
        occurredAt,
        sourceEventId: 'evt_original_to_reverse',
        description: 'Tier 2 subscription activated.',
        lines: [
          { accountCode: '1000', debitMinor: 29_900, currency: 'USD' },
          { accountCode: '2000.family.tier2', creditMinor: 29_900, currency: 'USD' },
        ],
      },
      null,
    );
    if (!post.ok) {
      throw new Error('beforeEach: failed to post original');
    }
    originalId = post.value.id;
  });

  it('creates a reversal journal with debit/credit swapped + sets back-pointer', async () => {
    const result = await service.reverse(
      originalId,
      {
        sourceEventId: 'reversal_evt_001',
        occurredAt: '2026-05-15T00:00:00.000Z',
        reasonCode: 'BOOKING_DISPUTE_REFUND',
      },
      'usr_admin_finance',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('reversal');
    expect(result.value.reversedJournalId).toBe(originalId);
    expect(result.value.lines).toHaveLength(2);
    // The original had debit on Cash, credit on Deferred Revenue;
    // the reversal swaps these.
    const cashLine = result.value.lines.find((l) => l.accountCode === '1000');
    const deferredLine = result.value.lines.find((l) => l.accountCode === '2000.family.tier2');
    expect(cashLine?.creditMinor).toBe(29_900);
    expect(cashLine?.debitMinor).toBe(0);
    expect(deferredLine?.debitMinor).toBe(29_900);
    expect(deferredLine?.creditMinor).toBe(0);

    // The original carries the back-pointer to the reversal.
    const original = fake.journalRows.find((j) => j.id === originalId);
    expect(original?.reversedByJournalId).toBe(result.value.id);
    // Context records the reason code + original event id.
    expect(result.value.context['reasonCode']).toBe('BOOKING_DISPUTE_REFUND');
    expect(result.value.context['reversedJournalId']).toBe(originalId);
    expect(result.value.context['originalSourceEventId']).toBe('evt_original_to_reverse');
  });

  it('rejects an unknown journal id with `journal_not_found`', async () => {
    const result = await service.reverse(
      'jrnl_not_a_thing',
      {
        sourceEventId: 'reversal_evt_002',
        occurredAt,
        reasonCode: 'X',
      },
      'usr_admin_finance',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('journal_not_found');
  });

  it('rejects a second reversal request with `already_reversed`', async () => {
    const first = await service.reverse(
      originalId,
      {
        sourceEventId: 'reversal_evt_first',
        occurredAt: '2026-05-15T00:00:00.000Z',
        reasonCode: 'BOOKING_DISPUTE_REFUND',
      },
      'usr_admin_finance',
    );
    expect(first.ok).toBe(true);

    const second = await service.reverse(
      originalId,
      {
        sourceEventId: 'reversal_evt_second',
        occurredAt: '2026-05-16T00:00:00.000Z',
        reasonCode: 'DOUBLE_REVERSAL_ATTEMPT',
      },
      'usr_admin_finance',
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.failure.kind).toBe('already_reversed');
    if (second.failure.kind !== 'already_reversed') return;
    if (!first.ok) return;
    expect(second.failure.reversedByJournalId).toBe(first.value.id);
  });

  it('records the reversal description when provided', async () => {
    const result = await service.reverse(
      originalId,
      {
        sourceEventId: 'reversal_evt_explicit_desc',
        occurredAt,
        reasonCode: 'OPS_ERROR',
        description: 'Operator entered the wrong tier.',
      },
      'usr_admin_finance',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.description).toBe('Operator entered the wrong tier.');
  });

  it('defaults the description to a derived label when omitted', async () => {
    const result = await service.reverse(
      originalId,
      {
        sourceEventId: 'reversal_evt_default_desc',
        occurredAt,
        reasonCode: 'OPS_ERROR',
      },
      'usr_admin_finance',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.description).toContain('Reversal of journal');
    expect(result.value.description).toContain('OPS_ERROR');
  });
});

describe('Decimal cents precision', () => {
  it('round-trips $0.01 exactly', async () => {
    const fake = new FakePrisma();
    fake.seedAccount('1000');
    fake.seedAccount('2000.family.tier2');
    const service = buildService(fake);

    const result = await service.post(
      {
        kind: 'subscription_activation',
        occurredAt,
        sourceEventId: 'evt_one_cent',
        description: 'One cent.',
        lines: [
          { accountCode: '1000', debitMinor: 1, currency: 'USD' },
          { accountCode: '2000.family.tier2', creditMinor: 1, currency: 'USD' },
        ],
      },
      null,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines[0]?.debitMinor).toBe(1);
    // The stored Decimal is `0.01` exactly — not 0.010000000000001.
    const persistedDebit = fake.lineRows[0]?.debit;
    expect(persistedDebit?.toFixed(2)).toBe('0.01');
  });
});
