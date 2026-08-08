import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { VerificationTokenPruneService } from './verification-token-prune.service';

const NOW = new Date('2026-08-02T12:00:00.000Z');
const DAY = 86_400_000;

interface Row {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface FindManyArgs {
  where: {
    createdAt: { lt: Date };
    OR: [{ consumedAt: { not: null } }, { expiresAt: { lt: Date } }];
  };
  take: number;
  orderBy: { createdAt: 'asc' | 'desc' };
}

class FakePrisma {
  public rows: Row[] = [];
  public lastFindArgs: FindManyArgs | null = null;

  emailVerificationToken = {
    findMany: vi.fn(async (args: FindManyArgs): Promise<{ id: string }[]> => {
      this.lastFindArgs = args;
      const cutoff = args.where.createdAt.lt;
      const expiredBefore = args.where.OR[1].expiresAt.lt;
      const matches = this.rows
        .filter(
          (r) =>
            r.createdAt.getTime() < cutoff.getTime() &&
            (r.consumedAt !== null || r.expiresAt.getTime() < expiredBefore.getTime()),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return matches.slice(0, args.take).map((r) => ({ id: r.id }));
    }),
    deleteMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
      const ids = new Set(args.where.id.in);
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => !ids.has(r.id));
      return { count: before - this.rows.length };
    }),
  };
}

function build(): { service: VerificationTokenPruneService; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  return {
    service: new VerificationTokenPruneService(prisma as unknown as PrismaService),
    prisma,
  };
}

function row(overrides: Partial<Row> & { id: string }): Row {
  return {
    createdAt: new Date(NOW.getTime() - 60 * DAY),
    expiresAt: new Date(NOW.getTime() - 59 * DAY),
    consumedAt: null,
    ...overrides,
  };
}

const ASK = { now: NOW, retentionDays: 30, batchSize: 5_000 } as const;

describe('VerificationTokenPruneService.prune', () => {
  it('deletes a long-spent row', async () => {
    const { service, prisma } = build();
    prisma.rows.push(row({ id: 'spent', consumedAt: new Date(NOW.getTime() - 59 * DAY) }));

    const result = await service.prune(ASK);

    expect(result).toEqual({ deletedCount: 1, truncated: false });
    expect(prisma.rows).toEqual([]);
  });

  it('deletes a long-expired unspent row', async () => {
    const { service, prisma } = build();
    prisma.rows.push(row({ id: 'expired' }));

    expect((await service.prune(ASK)).deletedCount).toBe(1);
  });

  it('KEEPS a row inside the retention window even though it is spent', async () => {
    // The rows survive for support questions ("did the link we sent you on
    // Tuesday work?"), not because the platform needs them.
    const { service, prisma } = build();
    prisma.rows.push(
      row({
        id: 'recent',
        createdAt: new Date(NOW.getTime() - 2 * DAY),
        expiresAt: new Date(NOW.getTime() - 1 * DAY),
        consumedAt: new Date(NOW.getTime() - 1 * DAY),
      }),
    );

    const result = await service.prune(ASK);

    expect(result.deletedCount).toBe(0);
    expect(prisma.rows).toHaveLength(1);
  });

  it('KEEPS an old row that is still live and unspent', async () => {
    // Both halves of the OR have to be false. A token created long ago with
    // a long TTL is still a working link, and deleting it would break a
    // person mid-click.
    const { service, prisma } = build();
    prisma.rows.push(
      row({
        id: 'old-but-live',
        createdAt: new Date(NOW.getTime() - 60 * DAY),
        expiresAt: new Date(NOW.getTime() + DAY),
        consumedAt: null,
      }),
    );

    expect((await service.prune(ASK)).deletedCount).toBe(0);
    expect(prisma.rows).toHaveLength(1);
  });

  it('cuts off on created_at, not on consumed_at', async () => {
    const { service, prisma } = build();
    await service.prune(ASK);
    expect(prisma.lastFindArgs?.where.createdAt.lt).toEqual(new Date(NOW.getTime() - 30 * DAY));
  });

  it('reports truncated when the batch cap is hit, and drains oldest first', async () => {
    const { service, prisma } = build();
    for (let i = 0; i < 5; i += 1) {
      prisma.rows.push(
        row({ id: `t${String(i)}`, createdAt: new Date(NOW.getTime() - (60 + i) * DAY) }),
      );
    }

    const result = await service.prune({ ...ASK, batchSize: 2 });

    expect(result).toEqual({ deletedCount: 2, truncated: true });
    // Oldest first: t4 (-64d) and t3 (-63d) go, the rest remain.
    expect(prisma.rows.map((r) => r.id).sort()).toEqual(['t0', 't1', 't2']);
  });

  it('is idempotent — a second tick against a drained table deletes nothing', async () => {
    const { service, prisma } = build();
    prisma.rows.push(row({ id: 'a' }));

    await service.prune(ASK);
    const second = await service.prune(ASK);

    expect(second).toEqual({ deletedCount: 0, truncated: false });
  });

  it('does no delete at all when nothing matches', async () => {
    const { service, prisma } = build();
    const result = await service.prune(ASK);
    expect(result).toEqual({ deletedCount: 0, truncated: false });
    expect(prisma.emailVerificationToken.deleteMany).not.toHaveBeenCalled();
  });

  it('reports the ACTUAL deleted count when a concurrent delete got there first', async () => {
    const { service, prisma } = build();
    prisma.rows.push(row({ id: 'a' }), row({ id: 'b' }));
    // Simulate a cascading user delete removing one row between the select
    // and the delete. Reporting the selected count would inflate the metric.
    prisma.emailVerificationToken.deleteMany.mockResolvedValueOnce({ count: 1 });

    expect((await service.prune(ASK)).deletedCount).toBe(1);
  });
});
