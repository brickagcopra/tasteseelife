import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { PrivacyOverdueSweepService } from './privacy-overdue-sweep.service';

/**
 * Unit tests for the overdue-DSAR scan (TS-309a-followup-2).
 *
 * The assertions that carry weight:
 *   - the count and the enumeration are INDEPENDENT, so a capped
 *     enumeration cannot make the metric under-report — and truncation is
 *     stated rather than implied by a short list;
 *   - overdue and due-soon PARTITION the live set: the request that is
 *     exactly at the deadline is late, not upcoming;
 *   - terminal statuses are excluded by a NOT, never a whitelist (a status
 *     added later must not silently vanish from a statutory queue);
 *   - the projection carries no free text and no subject identity — a log
 *     stream replicates far wider than the table.
 */

const NOW = new Date('2026-07-27T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

interface Capture {
  readonly counts: Array<Record<string, unknown>>;
  readonly finds: Array<Record<string, unknown>>;
}

function makePrisma(
  rows: ReadonlyArray<Record<string, unknown>>,
  counts: readonly number[],
): { prisma: PrismaService; capture: Capture } {
  const capture: Capture = { counts: [], finds: [] };
  let countCall = 0;
  const prisma = {
    dataSubjectRequest: {
      count: async (args: Record<string, unknown>) => {
        capture.counts.push(args);
        const value = counts[countCall] ?? 0;
        countCall += 1;
        return value;
      },
      findMany: async (args: Record<string, unknown>) => {
        capture.finds.push(args);
        const take = (args as { take?: number }).take ?? rows.length;
        return rows.slice(0, take);
      },
    },
  } as unknown as PrismaService;
  return { prisma, capture };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dsr_1',
    kind: 'access',
    status: 'in_progress',
    subjectKind: 'senior',
    selfService: false,
    dueAt: new Date(NOW.getTime() - 3 * DAY),
    extendedAt: null,
    ...overrides,
  };
}

describe('PrivacyOverdueSweepService', () => {
  it('reports the overdue and due-soon counts from their own queries', async () => {
    const { prisma } = makePrisma([row()], [4, 9]);
    const service = new PrivacyOverdueSweepService(prisma);

    const result = await service.sweep({ now: NOW, dueSoonDays: 7, maxLogged: 25 });

    expect(result.overdueCount).toBe(4);
    expect(result.dueSoonCount).toBe(9);
  });

  it('the COUNT is never capped by the enumeration cap', async () => {
    // The whole reason these are two queries: a capped `findMany.length`
    // used as the metric would report "2 late" during a 40-request
    // backlog, which is the opposite of an alarm.
    const { prisma } = makePrisma([row({ id: 'a' }), row({ id: 'b' })], [40, 0]);
    const service = new PrivacyOverdueSweepService(prisma);

    const result = await service.sweep({ now: NOW, dueSoonDays: 7, maxLogged: 2 });

    expect(result.overdueCount).toBe(40);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('does not claim truncation when everything overdue was enumerated', async () => {
    const { prisma } = makePrisma([row({ id: 'a' }), row({ id: 'b' })], [2, 0]);
    const service = new PrivacyOverdueSweepService(prisma);

    const result = await service.sweep({ now: NOW, dueSoonDays: 7, maxLogged: 25 });

    expect(result.truncated).toBe(false);
  });

  it('excludes terminal statuses with a NOT, not a whitelist of live ones', async () => {
    // A whitelist silently drops any status added later. On a statutory
    // queue that means losing work rather than showing a stale label.
    const { prisma, capture } = makePrisma([], [0, 0]);
    const service = new PrivacyOverdueSweepService(prisma);

    await service.sweep({ now: NOW, dueSoonDays: 7, maxLogged: 25 });

    const where = capture.counts[0]?.where as { status: { notIn: string[] } };
    expect(where.status.notIn).toEqual(
      expect.arrayContaining(['fulfilled', 'refused', 'withdrawn']),
    );
    expect(Object.keys(where.status)).toEqual(['notIn']);
  });

  it('partitions the live set — the deadline instant is OVERDUE, not due-soon', async () => {
    const { prisma, capture } = makePrisma([], [0, 0]);
    const service = new PrivacyOverdueSweepService(prisma);

    await service.sweep({ now: NOW, dueSoonDays: 7, maxLogged: 25 });

    const overdueWhere = capture.counts[0]?.where as { dueAt: { lt: Date } };
    const soonWhere = capture.counts[1]?.where as { dueAt: { gte: Date; lt: Date } };
    expect(overdueWhere.dueAt.lt).toEqual(NOW);
    expect(soonWhere.dueAt.gte).toEqual(NOW);
    expect(soonWhere.dueAt.lt).toEqual(new Date(NOW.getTime() + 7 * DAY));
  });

  it('honours the configured lead-time window', async () => {
    const { prisma, capture } = makePrisma([], [0, 0]);
    const service = new PrivacyOverdueSweepService(prisma);

    await service.sweep({ now: NOW, dueSoonDays: 30, maxLogged: 25 });

    const soonWhere = capture.counts[1]?.where as { dueAt: { lt: Date } };
    expect(soonWhere.dueAt.lt).toEqual(new Date(NOW.getTime() + 30 * DAY));
  });

  it('enumerates deadline-soonest first, tie-broken by id', async () => {
    const { prisma, capture } = makePrisma([], [0, 0]);
    const service = new PrivacyOverdueSweepService(prisma);

    await service.sweep({ now: NOW, dueSoonDays: 7, maxLogged: 25 });

    expect(capture.finds[0]?.orderBy).toEqual([{ dueAt: 'asc' }, { id: 'asc' }]);
  });

  it('computes whole days overdue and surfaces whether the extension is spent', async () => {
    const { prisma } = makePrisma(
      [
        row({ id: 'a', dueAt: new Date(NOW.getTime() - 3 * DAY - 3600_000) }),
        row({ id: 'b', dueAt: new Date(NOW.getTime() - 1_000), extendedAt: new Date() }),
      ],
      [2, 0],
    );
    const service = new PrivacyOverdueSweepService(prisma);

    const result = await service.sweep({ now: NOW, dueSoonDays: 7, maxLogged: 25 });

    expect(result.rows[0]?.daysOverdue).toBe(3);
    expect(result.rows[0]?.extended).toBe(false);
    expect(result.rows[1]?.daysOverdue).toBe(0);
    expect(result.rows[1]?.extended).toBe(true);
  });

  it('projects NO free text and NO subject identity', async () => {
    // `note`, `verificationMethod` and `refusalNote` are written by people
    // and may name anybody; `subjectId` / `requesterUserId` identify the
    // person the request is about. An operator opens the request by `id`
    // in a `privacy:read`-gated console instead.
    const { prisma, capture } = makePrisma([], [0, 0]);
    const service = new PrivacyOverdueSweepService(prisma);

    await service.sweep({ now: NOW, dueSoonDays: 7, maxLogged: 25 });

    const select = capture.finds[0]?.select as Record<string, boolean>;
    for (const forbidden of [
      'note',
      'verificationMethod',
      'refusalNote',
      'extensionReason',
      'subjectId',
      'requesterUserId',
      'verifiedByUserId',
    ]) {
      expect(select[forbidden]).toBeUndefined();
    }
  });

  it('emitted rows serialise without any free-text or subject-identity field', async () => {
    const { prisma } = makePrisma(
      [
        row({
          // Present on the model; a widened `select` would let these through.
          note: 'my mother is unwell and I want everything you hold',
          subjectId: 'sen_secret',
          requesterUserId: 'usr_secret',
        }),
      ],
      [1, 0],
    );
    const service = new PrivacyOverdueSweepService(prisma);

    const result = await service.sweep({ now: NOW, dueSoonDays: 7, maxLogged: 25 });

    const serialised = JSON.stringify(result.rows);
    expect(serialised).not.toContain('my mother');
    expect(serialised).not.toContain('sen_secret');
    expect(serialised).not.toContain('usr_secret');
  });

  it('a clean platform is a clean result, not an empty one', async () => {
    const { prisma } = makePrisma([], [0, 0]);
    const service = new PrivacyOverdueSweepService(prisma);

    const result = await service.sweep({ now: NOW, dueSoonDays: 7, maxLogged: 25 });

    expect(result).toEqual({ overdueCount: 0, dueSoonCount: 0, rows: [], truncated: false });
  });
});
