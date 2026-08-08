import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AdminJournalsController } from './admin-journals.controller';
import type {
  AdminJournalListPage,
  AdminJournalRow,
  AdminJournalsService,
} from '../services/admin-journals.service';

const NOW = new Date('2026-05-18T12:00:00.000Z');

function decimal(value: string): { toString(): string } {
  return { toString: () => value };
}

function buildRow(overrides: Partial<AdminJournalRow> = {}): AdminJournalRow {
  return {
    id: 'jnl_a',
    kind: 'subscription_activation',
    occurredAt: NOW,
    postedAt: NOW,
    sourceEventId: 'evt_x',
    description: 'Activation',
    periodId: 'per_a',
    periodName: '2026-05',
    postedByUserId: null,
    reversedJournalId: null,
    reversedByJournalId: null,
    context: { foo: 'bar' },
    lines: [
      {
        id: 'jln_a',
        accountId: 'acc_cash',
        accountCode: '1000',
        accountName: 'Cash',
        debit: decimal('299.00'),
        credit: decimal('0'),
        currency: 'USD',
        memo: null,
      },
      {
        id: 'jln_b',
        accountId: 'acc_def',
        accountCode: '2000.family.tier2',
        accountName: 'Deferred Revenue T2',
        debit: decimal('0'),
        credit: decimal('299.00'),
        currency: 'USD',
        memo: 'tier 2 activation',
      },
    ],
    ...overrides,
  };
}

function buildService(opts: {
  list?: () => Promise<AdminJournalListPage>;
  getById?: () => Promise<AdminJournalRow | null>;
}): AdminJournalsService {
  return {
    list: vi.fn(opts.list ?? (async () => ({ journals: [], nextCursor: null }))),
    getById: vi.fn(opts.getById ?? (async () => null)),
  } as unknown as AdminJournalsService;
}

describe('AdminJournalsController.list', () => {
  it('returns an empty list when the service returns nothing', async () => {
    const service = buildService({});
    const controller = new AdminJournalsController(service);
    const result = await controller.list({ limit: 25 });
    expect(result.journals).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('maps row to summary DTO with totals + ISO timestamps', async () => {
    const service = buildService({
      list: async () => ({ journals: [buildRow()], nextCursor: 'next_x' }),
    });
    const controller = new AdminJournalsController(service);
    const result = await controller.list({ limit: 25 });
    expect(result.journals).toHaveLength(1);
    const dto = result.journals[0]!;
    expect(dto.id).toBe('jnl_a');
    expect(dto.kind).toBe('subscription_activation');
    expect(dto.occurredAt).toBe(NOW.toISOString());
    expect(dto.totalDebitMinor).toBe(29_900);
    expect(dto.totalCreditMinor).toBe(29_900);
    expect(dto.lineCount).toBe(2);
    expect(dto.currency).toBe('USD');
    expect(result.nextCursor).toBe('next_x');
  });

  it('forwards filters into the service call', async () => {
    const listSpy = vi.fn(async () => ({ journals: [], nextCursor: null }));
    const service = buildService({ list: listSpy });
    const controller = new AdminJournalsController(service);
    await controller.list({
      periodId: 'per_x',
      periodName: '2026-05',
      kind: 'booking_completion',
      cursor: 'cur_x',
      limit: 42,
    });
    expect(listSpy).toHaveBeenCalledWith({
      periodId: 'per_x',
      periodName: '2026-05',
      kind: 'booking_completion',
      cursor: 'cur_x',
      limit: 42,
    });
  });
});

describe('AdminJournalsController.getById', () => {
  it('returns the detail DTO with lines + context when found', async () => {
    const service = buildService({
      getById: async () => buildRow({ id: 'jnl_x' }),
    });
    const controller = new AdminJournalsController(service);
    const result = await controller.getById('jnl_x');
    expect(result.journal.id).toBe('jnl_x');
    expect(result.journal.lines).toHaveLength(2);
    expect(result.journal.lines[0]?.debitMinor).toBe(29_900);
    expect(result.journal.lines[1]?.creditMinor).toBe(29_900);
    expect(result.journal.context).toEqual({ foo: 'bar' });
  });

  it('throws 404 when the service returns null', async () => {
    const service = buildService({ getById: async () => null });
    const controller = new AdminJournalsController(service);
    await expect(controller.getById('jnl_missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 404 on an oversized id', async () => {
    const service = buildService({});
    const controller = new AdminJournalsController(service);
    await expect(controller.getById('x'.repeat(100))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 404 on an empty id', async () => {
    const service = buildService({});
    const controller = new AdminJournalsController(service);
    await expect(controller.getById('')).rejects.toBeInstanceOf(NotFoundException);
  });
});
