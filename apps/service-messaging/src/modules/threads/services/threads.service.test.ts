import { describe, expect, it } from 'vitest';

import type { PrismaService, PrismaTransactionClient } from '../../../prisma/prisma.service';
import type { ThreadKind, ThreadParticipantRole } from '../../../realtime/thread-posting-policy';

import { ThreadsService } from './threads.service';

/**
 * Unit tests for {@link ThreadsService} (TS-070-followup-2).
 *
 * The collaborator is an in-memory `FakePrisma` that models just enough of
 * the `messaging.threads` + `messaging.thread_participants` tables to exercise
 * the create transaction, the inbox read, the detail trust gate, and the
 * roster mutations (including the idempotent + unique-violation paths). The
 * `select` clauses are honoured loosely — the fake returns full rows and the
 * service projects the fields it needs — which is faithful because the service
 * constructs every DTO field explicitly.
 */

interface ThreadRow {
  id: string;
  kind: ThreadKind;
  householdId: string | null;
  bookingId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

interface ParticipantRow {
  threadId: string;
  userId: string;
  role: ThreadParticipantRole;
  joinedAt: Date;
  lastReadMessageId: string | null;
}

const PRISMA_UNIQUE_VIOLATION = 'P2002';

/** Deterministic, monotonically-increasing clock so ordering assertions are stable (CLAUDE.md §9.3). */
class FakeClock {
  private tickMs = 0;
  next(): Date {
    this.tickMs += 1000;
    return new Date(Date.UTC(2026, 0, 1) + this.tickMs);
  }
}

interface ThreadSeed {
  readonly id: string;
  readonly kind: ThreadKind;
  readonly householdId?: string | null;
  readonly bookingId?: string | null;
  readonly archivedAt?: Date | null;
}

interface ParticipantSeed {
  readonly threadId: string;
  readonly userId: string;
  readonly role: ThreadParticipantRole;
  readonly lastReadMessageId?: string | null;
}

class FakePrisma {
  private readonly clock = new FakeClock();
  private threadCounter = 0;
  readonly threads: ThreadRow[] = [];
  readonly participants: ParticipantRow[] = [];

  /** Test helper — preload a thread without going through `create`. */
  seedThread(seed: ThreadSeed): void {
    const now = this.clock.next();
    this.threads.push({
      id: seed.id,
      kind: seed.kind,
      householdId: seed.householdId ?? null,
      bookingId: seed.bookingId ?? null,
      createdAt: now,
      updatedAt: now,
      archivedAt: seed.archivedAt ?? null,
    });
  }

  /** Test helper — preload a membership row. */
  seedParticipant(seed: ParticipantSeed): void {
    this.participants.push({
      threadId: seed.threadId,
      userId: seed.userId,
      role: seed.role,
      joinedAt: this.clock.next(),
      lastReadMessageId: seed.lastReadMessageId ?? null,
    });
  }

  private findThread(id: string): ThreadRow | undefined {
    return this.threads.find((t) => t.id === id);
  }

  private findParticipant(threadId: string, userId: string): ParticipantRow | undefined {
    return this.participants.find((p) => p.threadId === threadId && p.userId === userId);
  }

  readonly thread = {
    create: async (args: {
      data: { kind: ThreadKind; householdId: string | null; bookingId: string | null };
    }): Promise<ThreadRow> => {
      this.threadCounter += 1;
      const now = this.clock.next();
      const row: ThreadRow = {
        id: `thr_${this.threadCounter}`,
        kind: args.data.kind,
        householdId: args.data.householdId,
        bookingId: args.data.bookingId,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      this.threads.push(row);
      return row;
    },
    findUnique: async (args: {
      where: { id: string };
      select: { participants?: unknown };
    }): Promise<unknown> => {
      const thread = this.findThread(args.where.id);
      if (thread === undefined) return null;
      if (args.select.participants !== undefined) {
        const participants = this.participants
          .filter((p) => p.threadId === thread.id)
          .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
        return { ...thread, participants };
      }
      return thread;
    },
  };

  readonly threadParticipant = {
    createMany: async (args: {
      data: readonly { threadId: string; userId: string; role: ThreadParticipantRole }[];
    }): Promise<{ count: number }> => {
      for (const d of args.data) {
        if (this.findParticipant(d.threadId, d.userId) !== undefined) {
          throw { code: PRISMA_UNIQUE_VIOLATION };
        }
        this.participants.push({
          threadId: d.threadId,
          userId: d.userId,
          role: d.role,
          joinedAt: this.clock.next(),
          lastReadMessageId: null,
        });
      }
      return { count: args.data.length };
    },
    findMany: async (args: {
      where: {
        threadId?: string;
        userId?: string;
        thread?: { archivedAt: null };
      };
      orderBy: { joinedAt: 'asc' | 'desc' };
      take?: number;
      select: { thread?: unknown };
    }): Promise<unknown[]> => {
      // Inbox read (where.userId present) → nested thread + _count shape.
      if (args.where.userId !== undefined) {
        const userId = args.where.userId;
        const excludeArchived = args.where.thread?.archivedAt === null;
        const rows = this.participants
          .filter((p) => p.userId === userId)
          .map((p) => ({ p, thread: this.findThread(p.threadId) }))
          .filter((r): r is { p: ParticipantRow; thread: ThreadRow } => r.thread !== undefined)
          .filter((r) => (excludeArchived ? r.thread.archivedAt === null : true))
          .sort((a, b) => b.p.joinedAt.getTime() - a.p.joinedAt.getTime());
        const limited = args.take === undefined ? rows : rows.slice(0, args.take);
        return limited.map((r) => ({
          role: r.p.role,
          lastReadMessageId: r.p.lastReadMessageId,
          thread: {
            ...r.thread,
            _count: {
              participants: this.participants.filter((x) => x.threadId === r.thread.id).length,
            },
          },
        }));
      }
      // Participant list for a thread (used inside create's transaction).
      const threadId = args.where.threadId;
      return this.participants
        .filter((p) => p.threadId === threadId)
        .sort((a, b) =>
          args.orderBy.joinedAt === 'asc'
            ? a.joinedAt.getTime() - b.joinedAt.getTime()
            : b.joinedAt.getTime() - a.joinedAt.getTime(),
        );
    },
    findUnique: async (args: {
      where: { threadId_userId: { threadId: string; userId: string } };
      select: { thread?: unknown };
    }): Promise<unknown> => {
      const { threadId, userId } = args.where.threadId_userId;
      const row = this.findParticipant(threadId, userId);
      if (row === undefined) return null;
      if (args.select.thread !== undefined) {
        const thread = this.findThread(threadId);
        return {
          role: row.role,
          thread: { kind: thread?.kind, archivedAt: thread?.archivedAt ?? null },
        };
      }
      return row;
    },
    create: async (args: {
      data: { threadId: string; userId: string; role: ThreadParticipantRole };
    }): Promise<ParticipantRow> => {
      if (this.findParticipant(args.data.threadId, args.data.userId) !== undefined) {
        throw { code: PRISMA_UNIQUE_VIOLATION };
      }
      const row: ParticipantRow = {
        threadId: args.data.threadId,
        userId: args.data.userId,
        role: args.data.role,
        joinedAt: this.clock.next(),
        lastReadMessageId: null,
      };
      this.participants.push(row);
      return row;
    },
    delete: async (args: {
      where: { threadId_userId: { threadId: string; userId: string } };
    }): Promise<{ threadId: string }> => {
      const { threadId, userId } = args.where.threadId_userId;
      const idx = this.participants.findIndex(
        (p) => p.threadId === threadId && p.userId === userId,
      );
      if (idx === -1) throw new Error('record not found');
      this.participants.splice(idx, 1);
      return { threadId };
    },
  };

  $transaction = async <T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T> => {
    return fn(this as unknown as PrismaTransactionClient);
  };
}

function makeService(): { service: ThreadsService; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  const service = new ThreadsService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe('ThreadsService.createThread', () => {
  it('creates a thread, implicitly seeding the creator as a member', async () => {
    const { service, prisma } = makeService();

    const thread = await service.createThread({
      kind: 'household',
      householdId: 'hh_1',
      bookingId: null,
      participants: [{ userId: 'usr_obs', role: 'observer' }],
      ensureMemberUserId: 'usr_creator',
    });

    expect(thread.kind).toBe('household');
    expect(thread.householdId).toBe('hh_1');
    expect(thread.participants).toHaveLength(2);
    const creator = thread.participants.find((p) => p.userId === 'usr_creator');
    expect(creator?.role).toBe('member');
    expect(prisma.participants).toHaveLength(2);
    // ISO-8601 serialisation at the boundary.
    expect(thread.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not override an explicit creator role named in the participants list', async () => {
    const { service } = makeService();

    const thread = await service.createThread({
      kind: 'concierge',
      householdId: 'hh_2',
      bookingId: null,
      participants: [{ userId: 'usr_creator', role: 'concierge' }],
      ensureMemberUserId: 'usr_creator',
    });

    expect(thread.participants).toHaveLength(1);
    expect(thread.participants[0]?.role).toBe('concierge');
  });

  it('supports a system create with no implicit member (event-driven provisioning)', async () => {
    const { service } = makeService();

    const thread = await service.createThread({
      kind: 'booking',
      householdId: 'hh_3',
      bookingId: 'bk_3',
      participants: [
        { userId: 'usr_fam', role: 'member' },
        { userId: 'usr_prov', role: 'member' },
      ],
      ensureMemberUserId: null,
    });

    expect(thread.bookingId).toBe('bk_3');
    expect(thread.participants.map((p) => p.userId).sort()).toEqual(['usr_fam', 'usr_prov']);
  });
});

describe('ThreadsService.listInbox', () => {
  it('returns the caller’s threads newest membership first with role + count facets', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({ id: 'thr_a', kind: 'household', householdId: 'hh_1' });
    prisma.seedThread({ id: 'thr_b', kind: 'booking', householdId: 'hh_1', bookingId: 'bk_1' });
    prisma.seedParticipant({ threadId: 'thr_a', userId: 'usr_1', role: 'member' });
    prisma.seedParticipant({ threadId: 'thr_a', userId: 'usr_other', role: 'observer' });
    prisma.seedParticipant({ threadId: 'thr_b', userId: 'usr_1', role: 'member' });

    const inbox = await service.listInbox({ userId: 'usr_1', limit: 50, includeArchived: false });

    // thr_b membership was created after thr_a's → newest first.
    expect(inbox.map((e) => e.id)).toEqual(['thr_b', 'thr_a']);
    const a = inbox.find((e) => e.id === 'thr_a');
    expect(a?.myRole).toBe('member');
    expect(a?.participantCount).toBe(2);
  });

  it('excludes archived threads unless includeArchived is set', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({ id: 'thr_live', kind: 'household', householdId: 'hh_1' });
    prisma.seedThread({
      id: 'thr_archived',
      kind: 'household',
      householdId: 'hh_1',
      archivedAt: new Date('2026-03-01T00:00:00Z'),
    });
    prisma.seedParticipant({ threadId: 'thr_live', userId: 'usr_1', role: 'member' });
    prisma.seedParticipant({ threadId: 'thr_archived', userId: 'usr_1', role: 'member' });

    const excluded = await service.listInbox({
      userId: 'usr_1',
      limit: 50,
      includeArchived: false,
    });
    expect(excluded.map((e) => e.id)).toEqual(['thr_live']);

    const included = await service.listInbox({ userId: 'usr_1', limit: 50, includeArchived: true });
    expect(included.map((e) => e.id).sort()).toEqual(['thr_archived', 'thr_live']);
  });

  it('respects the limit', async () => {
    const { service, prisma } = makeService();
    for (let i = 0; i < 5; i += 1) {
      prisma.seedThread({ id: `thr_${i}`, kind: 'household', householdId: 'hh_1' });
      prisma.seedParticipant({ threadId: `thr_${i}`, userId: 'usr_1', role: 'member' });
    }
    const inbox = await service.listInbox({ userId: 'usr_1', limit: 2, includeArchived: false });
    expect(inbox).toHaveLength(2);
  });
});

describe('ThreadsService.getThreadDetailForMember', () => {
  it('returns detail with participants for a member', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({ id: 'thr_1', kind: 'household', householdId: 'hh_1' });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_1', role: 'member' });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_2', role: 'observer' });

    const detail = await service.getThreadDetailForMember('thr_1', 'usr_1');
    expect(detail).not.toBeNull();
    expect(detail?.participants).toHaveLength(2);
  });

  it('returns null for a non-participant (no existence leak)', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({ id: 'thr_1', kind: 'household', householdId: 'hh_1' });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_1', role: 'member' });

    expect(await service.getThreadDetailForMember('thr_1', 'usr_outsider')).toBeNull();
  });

  it('returns null for a thread that does not exist', async () => {
    const { service } = makeService();
    expect(await service.getThreadDetailForMember('thr_missing', 'usr_1')).toBeNull();
  });
});

describe('ThreadsService.addParticipant', () => {
  it('adds a new participant when the caller holds a posting role', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({ id: 'thr_1', kind: 'household', householdId: 'hh_1' });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_admin', role: 'member' });

    const result = await service.addParticipant({
      threadId: 'thr_1',
      requesterUserId: 'usr_admin',
      userId: 'usr_new',
      role: 'observer',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outcome).toBe('added');
      expect(result.value.participant.userId).toBe('usr_new');
    }
  });

  it('is idempotent — re-adding an existing participant returns already_present without changing the role', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({ id: 'thr_1', kind: 'household', householdId: 'hh_1' });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_admin', role: 'member' });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_existing', role: 'observer' });

    const result = await service.addParticipant({
      threadId: 'thr_1',
      requesterUserId: 'usr_admin',
      userId: 'usr_existing',
      role: 'member',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outcome).toBe('already_present');
      expect(result.value.participant.role).toBe('observer');
    }
  });

  it('rejects a non-participant caller with not_a_participant', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({ id: 'thr_1', kind: 'household', householdId: 'hh_1' });

    const result = await service.addParticipant({
      threadId: 'thr_1',
      requesterUserId: 'usr_outsider',
      userId: 'usr_new',
      role: 'member',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('not_a_participant');
  });

  it('rejects an observer caller with forbidden_role', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({ id: 'thr_1', kind: 'household', householdId: 'hh_1' });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_obs', role: 'observer' });

    const result = await service.addParticipant({
      threadId: 'thr_1',
      requesterUserId: 'usr_obs',
      userId: 'usr_new',
      role: 'member',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('forbidden_role');
  });

  it('rejects mutation on an archived thread with thread_archived', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({
      id: 'thr_1',
      kind: 'household',
      householdId: 'hh_1',
      archivedAt: new Date('2026-03-01T00:00:00Z'),
    });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_admin', role: 'member' });

    const result = await service.addParticipant({
      threadId: 'thr_1',
      requesterUserId: 'usr_admin',
      userId: 'usr_new',
      role: 'member',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('thread_archived');
  });
});

describe('ThreadsService.removeParticipant', () => {
  it('lets a participant remove themselves (leave) regardless of role', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({ id: 'thr_1', kind: 'household', householdId: 'hh_1' });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_obs', role: 'observer' });

    const result = await service.removeParticipant({
      threadId: 'thr_1',
      requesterUserId: 'usr_obs',
      userId: 'usr_obs',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.outcome).toBe('removed');
    expect(prisma.participants).toHaveLength(0);
  });

  it('lets a self-leave succeed even on an archived thread', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({
      id: 'thr_1',
      kind: 'household',
      householdId: 'hh_1',
      archivedAt: new Date('2026-03-01T00:00:00Z'),
    });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_1', role: 'member' });

    const result = await service.removeParticipant({
      threadId: 'thr_1',
      requesterUserId: 'usr_1',
      userId: 'usr_1',
    });

    expect(result.ok).toBe(true);
  });

  it('lets a posting-role caller remove someone else', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({ id: 'thr_1', kind: 'household', householdId: 'hh_1' });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_admin', role: 'member' });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_target', role: 'observer' });

    const result = await service.removeParticipant({
      threadId: 'thr_1',
      requesterUserId: 'usr_admin',
      userId: 'usr_target',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.outcome).toBe('removed');
  });

  it('rejects an observer removing someone else with forbidden_role', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({ id: 'thr_1', kind: 'household', householdId: 'hh_1' });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_obs', role: 'observer' });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_target', role: 'member' });

    const result = await service.removeParticipant({
      threadId: 'thr_1',
      requesterUserId: 'usr_obs',
      userId: 'usr_target',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('forbidden_role');
  });

  it('is idempotent — removing a non-participant returns not_present', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({ id: 'thr_1', kind: 'household', householdId: 'hh_1' });
    prisma.seedParticipant({ threadId: 'thr_1', userId: 'usr_admin', role: 'member' });

    const result = await service.removeParticipant({
      threadId: 'thr_1',
      requesterUserId: 'usr_admin',
      userId: 'usr_ghost',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.outcome).toBe('not_present');
  });

  it('rejects a self-leave by a non-participant with not_a_participant', async () => {
    const { service, prisma } = makeService();
    prisma.seedThread({ id: 'thr_1', kind: 'household', householdId: 'hh_1' });

    const result = await service.removeParticipant({
      threadId: 'thr_1',
      requesterUserId: 'usr_outsider',
      userId: 'usr_outsider',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('not_a_participant');
  });
});
