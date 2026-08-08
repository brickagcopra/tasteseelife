import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { AdminJournalsService, decodeCursor, encodeCursor } from './admin-journals.service';

const NOW = new Date('2026-05-18T12:00:00.000Z');
const EARLIER = new Date('2026-05-17T12:00:00.000Z');

function decimal(value: string): { toString(): string } {
  return { toString: () => value };
}

interface PersistedJournalListRow {
  readonly id: string;
  readonly kind: string;
  readonly occurredAt: Date;
  readonly postedAt: Date;
  readonly sourceEventId: string;
  readonly description: string;
  readonly periodId: string;
  readonly period: { readonly id: string; readonly name: string };
  readonly postedByUserId: string | null;
  readonly reversedJournalId: string | null;
  readonly reversedByJournalId: string | null;
  readonly context: unknown;
  readonly lines: readonly {
    readonly id: string;
    readonly accountId: string;
    readonly debit: { toString(): string };
    readonly credit: { toString(): string };
    readonly currency: string;
    readonly memo: string | null;
    readonly account: { readonly code: string; readonly name: string };
  }[];
}

function buildRow(overrides: Partial<PersistedJournalListRow> = {}): PersistedJournalListRow {
  return {
    id: overrides.id ?? 'jnl_default',
    kind: overrides.kind ?? 'subscription_activation',
    occurredAt: overrides.occurredAt ?? NOW,
    postedAt: overrides.postedAt ?? NOW,
    sourceEventId: overrides.sourceEventId ?? 'evt_default',
    description: overrides.description ?? 'Test journal',
    periodId: overrides.periodId ?? 'per_a',
    period: overrides.period ?? { id: 'per_a', name: '2026-05' },
    postedByUserId: overrides.postedByUserId ?? null,
    reversedJournalId: overrides.reversedJournalId ?? null,
    reversedByJournalId: overrides.reversedByJournalId ?? null,
    context: overrides.context ?? {},
    lines: overrides.lines ?? [
      {
        id: 'jln_a',
        accountId: 'acc_cash',
        debit: decimal('299.00'),
        credit: decimal('0'),
        currency: 'USD',
        memo: null,
        account: { code: '1000', name: 'Cash' },
      },
      {
        id: 'jln_b',
        accountId: 'acc_def',
        debit: decimal('0'),
        credit: decimal('299.00'),
        currency: 'USD',
        memo: null,
        account: { code: '2000.family.tier2', name: 'Deferred Revenue T2' },
      },
    ],
  };
}

function buildPrismaStub(opts: {
  journalFindMany?: (args: unknown) => Promise<PersistedJournalListRow[]>;
  journalFindUnique?: (args: unknown) => Promise<PersistedJournalListRow | null>;
  periodFindUnique?: (args: unknown) => Promise<{ id: string } | null>;
}): PrismaService {
  return {
    journal: {
      findMany: vi.fn(opts.journalFindMany ?? (async () => [])),
      findUnique: vi.fn(opts.journalFindUnique ?? (async () => null)),
    },
    accountingPeriod: {
      findUnique: vi.fn(opts.periodFindUnique ?? (async () => null)),
    },
  } as unknown as PrismaService;
}

describe('AdminJournalsService cursor codec', () => {
  it('round-trips an (occurredAt, id) pair', () => {
    const encoded = encodeCursor(NOW, 'jnl_abc');
    const decoded = decodeCursor(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.occurredAt.getTime()).toBe(NOW.getTime());
    expect(decoded?.id).toBe('jnl_abc');
  });

  it('returns null on undefined / malformed / empty-id inputs', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('!!!not-base64')).toBeNull();
    const noPipe = Buffer.from('nopipe', 'utf8').toString('base64url');
    expect(decodeCursor(noPipe)).toBeNull();
    const badDate = Buffer.from('not-a-date|jnl_x', 'utf8').toString('base64url');
    expect(decodeCursor(badDate)).toBeNull();
    const emptyId = Buffer.from(`${NOW.toISOString()}|`, 'utf8').toString('base64url');
    expect(decodeCursor(emptyId)).toBeNull();
  });
});

describe('AdminJournalsService.list', () => {
  it('returns empty page when no journals match', async () => {
    const prisma = buildPrismaStub({ journalFindMany: async () => [] });
    const service = new AdminJournalsService(prisma);
    const page = await service.list({ limit: 25 });
    expect(page.journals).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('emits no cursor when page is not full', async () => {
    const prisma = buildPrismaStub({
      journalFindMany: async () => [buildRow({ id: 'jnl_1' })],
    });
    const service = new AdminJournalsService(prisma);
    const page = await service.list({ limit: 25 });
    expect(page.journals).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('emits nextCursor when page is full', async () => {
    const prisma = buildPrismaStub({
      journalFindMany: async () => [
        buildRow({ id: 'jnl_1', occurredAt: NOW }),
        buildRow({ id: 'jnl_2', occurredAt: EARLIER }),
        buildRow({ id: 'jnl_3', occurredAt: new Date('2026-05-16T12:00:00.000Z') }),
      ],
    });
    const service = new AdminJournalsService(prisma);
    const page = await service.list({ limit: 2 });
    expect(page.journals).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const decoded = decodeCursor(page.nextCursor!);
    expect(decoded?.id).toBe('jnl_2');
  });

  it('forwards periodId + kind filters to where clause', async () => {
    const findMany = vi.fn(async (_args: unknown): Promise<PersistedJournalListRow[]> => []);
    const prisma = buildPrismaStub({ journalFindMany: findMany });
    const service = new AdminJournalsService(prisma);
    await service.list({
      periodId: 'per_xyz',
      kind: 'booking_completion',
      limit: 25,
    });
    const callArgs = findMany.mock.calls.at(0)?.[0] as {
      where: Record<string, unknown>;
    };
    expect(callArgs.where).toMatchObject({
      periodId: 'per_xyz',
      kind: 'booking_completion',
    });
  });

  it('resolves periodName → periodId before applying where filter', async () => {
    const findMany = vi.fn(async (_args: unknown): Promise<PersistedJournalListRow[]> => []);
    const prisma = buildPrismaStub({
      journalFindMany: findMany,
      periodFindUnique: async () => ({ id: 'per_resolved' }),
    });
    const service = new AdminJournalsService(prisma);
    await service.list({ periodName: '2026-05', limit: 25 });
    const callArgs = findMany.mock.calls.at(0)?.[0] as {
      where: Record<string, unknown>;
    };
    expect(callArgs.where).toMatchObject({ periodId: 'per_resolved' });
  });

  it('returns empty page when periodName resolves to unknown period', async () => {
    const findMany = vi.fn(async (_args: unknown): Promise<PersistedJournalListRow[]> => []);
    const prisma = buildPrismaStub({
      journalFindMany: findMany,
      periodFindUnique: async () => null,
    });
    const service = new AdminJournalsService(prisma);
    const page = await service.list({ periodName: '1999-01', limit: 25 });
    expect(page.journals).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('periodId wins when both periodId + periodName supplied', async () => {
    const findMany = vi.fn(async (_args: unknown): Promise<PersistedJournalListRow[]> => []);
    const periodFindUnique = vi.fn(async () => ({ id: 'per_should_lose' }));
    const prisma = buildPrismaStub({
      journalFindMany: findMany,
      periodFindUnique,
    });
    const service = new AdminJournalsService(prisma);
    await service.list({
      periodId: 'per_wins',
      periodName: '2026-05',
      limit: 25,
    });
    expect(periodFindUnique).not.toHaveBeenCalled();
    const callArgs = findMany.mock.calls.at(0)?.[0] as {
      where: Record<string, unknown>;
    };
    expect(callArgs.where).toMatchObject({ periodId: 'per_wins' });
  });

  it('applies cursor predicate when one is supplied', async () => {
    const findMany = vi.fn(async (_args: unknown): Promise<PersistedJournalListRow[]> => []);
    const prisma = buildPrismaStub({ journalFindMany: findMany });
    const service = new AdminJournalsService(prisma);
    const cursor = encodeCursor(NOW, 'jnl_anchor');
    await service.list({ cursor, limit: 25 });
    const callArgs = findMany.mock.calls.at(0)?.[0] as {
      where: { OR?: unknown[] };
    };
    expect(callArgs.where.OR).toBeDefined();
  });
});

describe('AdminJournalsService.getById', () => {
  it('returns the journal row when found', async () => {
    const prisma = buildPrismaStub({
      journalFindUnique: async () => buildRow({ id: 'jnl_x' }),
    });
    const service = new AdminJournalsService(prisma);
    const row = await service.getById('jnl_x');
    expect(row?.id).toBe('jnl_x');
    expect(row?.lines).toHaveLength(2);
  });

  it('returns null when not found', async () => {
    const prisma = buildPrismaStub({ journalFindUnique: async () => null });
    const service = new AdminJournalsService(prisma);
    const row = await service.getById('jnl_nope');
    expect(row).toBeNull();
  });
});
