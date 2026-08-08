import { describe, expect, it, vi } from 'vitest';

import {
  AccountingPeriodService,
  monthlyPeriodName,
  monthlyPeriodRange,
} from './accounting-period.service';

describe('monthlyPeriodName', () => {
  it('formats a UTC date as YYYY-MM', () => {
    expect(monthlyPeriodName(new Date('2026-05-13T00:00:00.000Z'))).toBe('2026-05');
  });

  it('zero-pads single-digit months', () => {
    expect(monthlyPeriodName(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01');
  });

  it('rolls a late-night-NY (UTC + 1) datetime into the next UTC month', () => {
    // May 31 23:30 -04:00 == June 1 03:30 UTC → June period.
    const ny = new Date('2026-05-31T23:30:00-04:00');
    expect(monthlyPeriodName(ny)).toBe('2026-06');
  });
});

describe('monthlyPeriodRange', () => {
  it('returns the first day and last day of the calendar month (UTC)', () => {
    const { startDate, endDate } = monthlyPeriodRange(new Date('2026-05-13T00:00:00.000Z'));
    expect(startDate.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(endDate.toISOString()).toBe('2026-05-31T00:00:00.000Z');
  });

  it('handles February correctly (28 days in 2026)', () => {
    const { endDate } = monthlyPeriodRange(new Date('2026-02-10T00:00:00.000Z'));
    expect(endDate.toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  it('handles leap-year February (29 days in 2028)', () => {
    const { endDate } = monthlyPeriodRange(new Date('2028-02-10T00:00:00.000Z'));
    expect(endDate.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('handles December (rolling into next year)', () => {
    const { startDate, endDate } = monthlyPeriodRange(new Date('2026-12-15T00:00:00.000Z'));
    expect(startDate.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(endDate.toISOString()).toBe('2026-12-31T00:00:00.000Z');
  });
});

describe('AccountingPeriodService.findOrCreateContaining', () => {
  it('returns the existing period when one already covers occurredAt', async () => {
    const existing = {
      id: 'prd_existing',
      name: '2026-05',
      status: 'open' as const,
    };
    const findUnique = vi.fn(async () => existing);
    const create = vi.fn();
    const tx = {
      accountingPeriod: { findUnique, create },
    };

    const service = new AccountingPeriodService();
    const result = await service.findOrCreateContaining(
      new Date('2026-05-13T00:00:00.000Z'),
      tx as never,
    );

    expect(result).toEqual(existing);
    expect(findUnique).toHaveBeenCalledWith({
      where: { name: '2026-05' },
      select: { id: true, name: true, status: true },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('lazy-creates the monthly period when no row exists', async () => {
    const findUnique = vi.fn(async () => null);
    const created = {
      id: 'prd_created',
      name: '2026-05',
      status: 'open' as const,
    };
    const create = vi.fn(async () => created);
    const tx = {
      accountingPeriod: { findUnique, create },
    };

    const service = new AccountingPeriodService();
    const result = await service.findOrCreateContaining(
      new Date('2026-05-13T00:00:00.000Z'),
      tx as never,
    );

    expect(result).toEqual(created);
    expect(create).toHaveBeenCalledWith({
      data: {
        name: '2026-05',
        startDate: new Date('2026-05-01T00:00:00.000Z'),
        endDate: new Date('2026-05-31T00:00:00.000Z'),
        status: 'open',
      },
      select: { id: true, name: true, status: true },
    });
  });

  it('refetches the winner on a P2002 race', async () => {
    const winnerRow = {
      id: 'prd_winner',
      name: '2026-05',
      status: 'open' as const,
    };

    let findUniqueCalls = 0;
    const findUnique = vi.fn(async () => {
      findUniqueCalls += 1;
      // First call (the pre-create lookup) sees no row; second call
      // (the post-P2002 refetch) sees the winner.
      return findUniqueCalls === 1 ? null : winnerRow;
    });

    const uniqueErr = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      name: 'PrismaClientKnownRequestError',
      meta: { target: ['name'] },
    });
    const create = vi.fn(async () => {
      throw uniqueErr;
    });
    const tx = {
      accountingPeriod: { findUnique, create },
    };

    const service = new AccountingPeriodService();
    const result = await service.findOrCreateContaining(
      new Date('2026-05-13T00:00:00.000Z'),
      tx as never,
    );

    expect(result).toEqual(winnerRow);
    expect(create).toHaveBeenCalledOnce();
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('rethrows non-P2002 errors verbatim', async () => {
    const findUnique = vi.fn(async () => null);
    const create = vi.fn(async () => {
      throw new Error('connection lost');
    });
    const tx = {
      accountingPeriod: { findUnique, create },
    };

    const service = new AccountingPeriodService();
    await expect(
      service.findOrCreateContaining(new Date('2026-05-13T00:00:00.000Z'), tx as never),
    ).rejects.toThrow('connection lost');
  });

  it('preserves a closed period status in the result', async () => {
    const closed = {
      id: 'prd_closed',
      name: '2026-04',
      status: 'closed' as const,
    };
    const findUnique = vi.fn(async () => closed);
    const tx = {
      accountingPeriod: {
        findUnique,
        create: vi.fn(),
      },
    };

    const service = new AccountingPeriodService();
    const result = await service.findOrCreateContaining(
      new Date('2026-04-15T00:00:00.000Z'),
      tx as never,
    );
    expect(result.status).toBe('closed');
  });
});
