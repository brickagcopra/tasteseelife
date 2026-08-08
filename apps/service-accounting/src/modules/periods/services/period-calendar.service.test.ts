import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import {
  PeriodCalendarService,
  compareYearMonth,
  decodeCursor,
  encodeCursor,
  enumerateMonths,
  parseYearMonth,
} from './period-calendar.service';

interface FakePeriodRow {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  status: 'open' | 'closed';
  closedAt: Date | null;
  closedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
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
  public rows: FakePeriodRow[] = [];
  /** Forces a UNIQUE violation on the next create whose `name` is in this set. */
  public forceUniqueOn: Set<string> = new Set();
  private autoId = 0;

  accountingPeriod = {
    findUnique: vi.fn(async (args: { where: { name?: string; id?: string } }) => {
      const w = args.where;
      if ('name' in w && w.name !== undefined) {
        return this.rows.find((r) => r.name === w.name) ?? null;
      }
      if ('id' in w && w.id !== undefined) {
        return this.rows.find((r) => r.id === w.id) ?? null;
      }
      return null;
    }),
    findMany: vi.fn(
      async (args: {
        where?: { name?: { in: string[] }; status?: 'open' | 'closed'; startDate?: { lt: Date } };
        orderBy?: { startDate: 'asc' | 'desc' };
        take?: number;
        select?: unknown;
      }) => {
        let filtered = [...this.rows];
        if (args.where?.name?.in !== undefined) {
          const names = new Set(args.where.name.in);
          filtered = filtered.filter((r) => names.has(r.name));
        }
        if (args.where?.status !== undefined) {
          filtered = filtered.filter((r) => r.status === args.where!.status);
        }
        if (args.where?.startDate?.lt !== undefined) {
          const lt = args.where.startDate.lt.getTime();
          filtered = filtered.filter((r) => r.startDate.getTime() < lt);
        }
        const dir = args.orderBy?.startDate ?? 'asc';
        filtered.sort((a, b) => {
          const diff = a.startDate.getTime() - b.startDate.getTime();
          return dir === 'desc' ? -diff : diff;
        });
        if (args.take !== undefined) {
          filtered = filtered.slice(0, args.take);
        }
        return filtered;
      },
    ),
    create: vi.fn(
      async (args: {
        data: { name: string; startDate: Date; endDate: Date; status: 'open' };
        select?: unknown;
      }) => {
        if (this.forceUniqueOn.has(args.data.name)) {
          this.forceUniqueOn.delete(args.data.name);
          // Pre-populate the row so the refetch finds it.
          this.autoId += 1;
          this.rows.push({
            id: `prd_winner_${this.autoId}`,
            name: args.data.name,
            startDate: args.data.startDate,
            endDate: args.data.endDate,
            status: 'open',
            closedAt: null,
            closedByUserId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          throw new PrismaUniqueViolation(['name']);
        }
        if (this.rows.some((r) => r.name === args.data.name)) {
          throw new PrismaUniqueViolation(['name']);
        }
        this.autoId += 1;
        const row: FakePeriodRow = {
          id: `prd_${this.autoId}`,
          name: args.data.name,
          startDate: args.data.startDate,
          endDate: args.data.endDate,
          status: 'open',
          closedAt: null,
          closedByUserId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.rows.push(row);
        return row;
      },
    ),
  };

  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

describe('parseYearMonth', () => {
  it('parses canonical YYYY-MM strings', () => {
    expect(parseYearMonth('2026-05')).toEqual({ year: 2026, month: 5 });
    expect(parseYearMonth('2099-12')).toEqual({ year: 2099, month: 12 });
  });

  it('returns null for malformed input', () => {
    expect(parseYearMonth('2026-13')).toBeNull();
    expect(parseYearMonth('2026-5')).toBeNull();
    expect(parseYearMonth('not-a-period')).toBeNull();
    expect(parseYearMonth('')).toBeNull();
  });
});

describe('compareYearMonth', () => {
  it('matches chronological order via lexicographic comparison', () => {
    expect(compareYearMonth('2026-01', '2026-12')).toBeLessThan(0);
    expect(compareYearMonth('2026-12', '2027-01')).toBeLessThan(0);
    expect(compareYearMonth('2026-05', '2026-05')).toBe(0);
    expect(compareYearMonth('2026-05', '2026-04')).toBeGreaterThan(0);
  });
});

describe('enumerateMonths', () => {
  it('enumerates a single-month range', () => {
    const months = enumerateMonths({ year: 2026, month: 5 }, { year: 2026, month: 5 });
    expect(months).toHaveLength(1);
    expect(months[0]?.name).toBe('2026-05');
    expect(months[0]?.startDate.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(months[0]?.endDate.toISOString()).toBe('2026-05-31T00:00:00.000Z');
  });

  it('enumerates a year-long range, including December → January rollover', () => {
    const months = enumerateMonths({ year: 2026, month: 11 }, { year: 2027, month: 2 });
    expect(months.map((m) => m.name)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });

  it('handles February correctly in a non-leap year', () => {
    const months = enumerateMonths({ year: 2026, month: 2 }, { year: 2026, month: 2 });
    expect(months[0]?.endDate.toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  it('handles February correctly in a leap year', () => {
    const months = enumerateMonths({ year: 2028, month: 2 }, { year: 2028, month: 2 });
    expect(months[0]?.endDate.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });
});

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a cursor through the YYYY-MM-DD encoding', () => {
    const date = new Date('2026-05-01T00:00:00.000Z');
    const encoded = encodeCursor(date);
    expect(encoded).toBe('2026-05-01');
    expect(decodeCursor(encoded)?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('rejects malformed cursors', () => {
    expect(decodeCursor('2026/05/01')).toBeNull();
    expect(decodeCursor('not-a-date')).toBeNull();
  });
});

describe('PeriodCalendarService.generateMonthly', () => {
  let prisma: FakePrisma;
  let service: PeriodCalendarService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new PeriodCalendarService(prisma as unknown as PrismaService);
  });

  it('creates every month in an empty range', async () => {
    const result = await service.generateMonthly('2026-05', '2026-07');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requestedCount).toBe(3);
    expect(result.value.createdCount).toBe(3);
    expect(result.value.existedCount).toBe(0);
    expect(result.value.created.map((p) => p.name)).toEqual(['2026-05', '2026-06', '2026-07']);
    expect(result.value.existed).toEqual([]);
  });

  it('reports pre-existing months in the existed list and skips re-insert', async () => {
    prisma.rows.push({
      id: 'prd_existing',
      name: '2026-05',
      startDate: new Date('2026-05-01T00:00:00.000Z'),
      endDate: new Date('2026-05-31T00:00:00.000Z'),
      status: 'open',
      closedAt: null,
      closedByUserId: null,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    });

    const result = await service.generateMonthly('2026-05', '2026-06');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requestedCount).toBe(2);
    expect(result.value.createdCount).toBe(1);
    expect(result.value.existedCount).toBe(1);
    // `created + existed === requested` — the pre-existing 2026-05
    // counts as existed; the newly-inserted 2026-06 counts as created.
    expect(result.value.created.map((p) => p.name)).toEqual(['2026-06']);
    expect(result.value.existed.map((p) => p.name)).toEqual(['2026-05']);
  });

  it('is fully idempotent when every requested month already exists', async () => {
    prisma.rows.push({
      id: 'prd_a',
      name: '2026-05',
      startDate: new Date('2026-05-01T00:00:00.000Z'),
      endDate: new Date('2026-05-31T00:00:00.000Z'),
      status: 'open',
      closedAt: null,
      closedByUserId: null,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    const result = await service.generateMonthly('2026-05', '2026-05');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.createdCount).toBe(0);
    expect(result.value.existedCount).toBe(1);
    expect(prisma.accountingPeriod.create).not.toHaveBeenCalled();
  });

  it('handles a concurrent-create race by refetching the winner', async () => {
    // The second month in the range will race — the fake throws P2002
    // on its create attempt and pre-populates the row so the refetch
    // finds it.
    prisma.forceUniqueOn.add('2026-06');

    const result = await service.generateMonthly('2026-05', '2026-06');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 2026-05 created normally; 2026-06 raced (concurrent generator
    // won) — from this caller's perspective, the racing winner counts
    // as `existed` because this call did not create it.
    expect(result.value.createdCount).toBe(1);
    expect(result.value.existedCount).toBe(1);
    expect(result.value.created.map((p) => p.name)).toEqual(['2026-05']);
    expect(result.value.existed.map((p) => p.name)).toEqual(['2026-06']);
  });

  it('returns range_inverted when start > end', async () => {
    const result = await service.generateMonthly('2026-06', '2026-05');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('range_inverted');
  });

  it('returns malformed_name when start is malformed', async () => {
    const result = await service.generateMonthly('not-a-period', '2026-05');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('malformed_name');
  });

  it('returns malformed_name when end is malformed', async () => {
    const result = await service.generateMonthly('2026-05', '2026-13');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('malformed_name');
  });

  it('returns range_exceeds_cap when the range covers more than the MAX_RANGE_MONTHS cap', async () => {
    // 2026-01 .. 2031-06 = 66 months — over the 60-month cap.
    const result = await service.generateMonthly('2026-01', '2031-06');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('range_exceeds_cap');
    if (result.failure.kind === 'range_exceeds_cap') {
      expect(result.failure.requestedCount).toBe(66);
      expect(result.failure.maxCount).toBe(60);
    }
  });
});

describe('PeriodCalendarService.getByName', () => {
  let prisma: FakePrisma;
  let service: PeriodCalendarService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new PeriodCalendarService(prisma as unknown as PrismaService);
  });

  it('returns the period DTO when it exists', async () => {
    prisma.rows.push({
      id: 'prd_abc',
      name: '2026-05',
      startDate: new Date('2026-05-01T00:00:00.000Z'),
      endDate: new Date('2026-05-31T00:00:00.000Z'),
      status: 'open',
      closedAt: null,
      closedByUserId: null,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    const result = await service.getByName('2026-05');
    expect(result).not.toBeNull();
    expect(result?.name).toBe('2026-05');
    expect(result?.startDate).toBe('2026-05-01');
  });

  it('returns null when no row matches', async () => {
    const result = await service.getByName('2099-12');
    expect(result).toBeNull();
  });
});

describe('PeriodCalendarService.list', () => {
  let prisma: FakePrisma;
  let service: PeriodCalendarService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new PeriodCalendarService(prisma as unknown as PrismaService);
  });

  function seedThreeMonths(): void {
    for (const month of ['2026-03', '2026-04', '2026-05']) {
      const [year, mm] = month.split('-') as [string, string];
      const yearNum = Number(year);
      const monthNum = Number(mm);
      prisma.rows.push({
        id: `prd_${month}`,
        name: month,
        startDate: new Date(Date.UTC(yearNum, monthNum - 1, 1)),
        endDate: new Date(Date.UTC(yearNum, monthNum, 0)),
        status: 'open',
        closedAt: null,
        closedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  it('lists periods newest first and returns null cursor when no more pages', async () => {
    seedThreeMonths();
    const result = await service.list({ limit: 10 });
    expect(result.periods.map((p) => p.name)).toEqual(['2026-05', '2026-04', '2026-03']);
    expect(result.nextCursor).toBeNull();
  });

  it('filters by status when provided', async () => {
    seedThreeMonths();
    // Flip 2026-04 to closed.
    const apr = prisma.rows.find((r) => r.name === '2026-04')!;
    apr.status = 'closed';
    apr.closedAt = new Date('2026-05-02T00:00:00.000Z');
    apr.closedByUserId = 'usr_finance';

    const open = await service.list({ status: 'open' });
    expect(open.periods.map((p) => p.name)).toEqual(['2026-05', '2026-03']);
    const closed = await service.list({ status: 'closed' });
    expect(closed.periods.map((p) => p.name)).toEqual(['2026-04']);
  });

  it('paginates with a cursor when the page is full', async () => {
    seedThreeMonths();
    const firstPage = await service.list({ limit: 2 });
    expect(firstPage.periods.map((p) => p.name)).toEqual(['2026-05', '2026-04']);
    expect(firstPage.nextCursor).toBe('2026-04-01');

    const secondPage = await service.list({ limit: 2, cursor: firstPage.nextCursor! });
    expect(secondPage.periods.map((p) => p.name)).toEqual(['2026-03']);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('caps the limit at 100', async () => {
    seedThreeMonths();
    const result = await service.list({ limit: 1000 });
    // No exception even though caller asked for a wild value.
    expect(result.periods).toHaveLength(3);
  });
});
