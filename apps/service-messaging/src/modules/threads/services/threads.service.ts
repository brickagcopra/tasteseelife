import { Injectable, Logger } from '@nestjs/common';
import type {
  AddThreadParticipantResponse,
  CreateThreadRequest,
  RemoveThreadParticipantResponse,
  ThreadInboxEntry,
  ThreadParticipantRecord,
  ThreadWithParticipantsRecord,
} from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import {
  canPostInThread,
  type ThreadKind,
  type ThreadParticipantRole,
} from '../../../realtime/thread-posting-policy';

import { err, ok, type Result } from './result';

/**
 * Local mirror of the Prisma-generated `threads` row, narrowed to the
 * columns this module reads. Same TS-021-followup-3 rationale documented
 * across the codebase — Prisma's row types resolve inconsistently under our
 * tsconfig so we project shapes by hand.
 */
interface ThreadRow {
  readonly id: string;
  readonly kind: ThreadKind;
  readonly householdId: string | null;
  readonly bookingId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
}

interface ParticipantRow {
  readonly threadId: string;
  readonly userId: string;
  readonly role: ThreadParticipantRole;
  readonly joinedAt: Date;
  readonly lastReadMessageId: string | null;
}

type ThreadWithParticipantsRow = ThreadRow & { readonly participants: readonly ParticipantRow[] };

type InboxRow = {
  readonly role: ThreadParticipantRole;
  readonly lastReadMessageId: string | null;
  readonly thread: ThreadRow & { readonly _count: { readonly participants: number } };
};

/** Explicit column projections — never `SELECT *` (CLAUDE.md §4.1). */
const THREAD_SELECT = {
  id: true,
  kind: true,
  householdId: true,
  bookingId: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
} as const;

const PARTICIPANT_SELECT = {
  threadId: true,
  userId: true,
  role: true,
  joinedAt: true,
  lastReadMessageId: true,
} as const;

export interface CreateThreadInput {
  readonly kind: CreateThreadRequest['kind'];
  readonly householdId: string | null;
  readonly bookingId: string | null;
  readonly participants: readonly {
    readonly userId: string;
    readonly role: ThreadParticipantRole;
  }[];
  /**
   * A user id to guarantee is a `member` of the new thread (the authenticated
   * creator from the controller, so they can immediately read what they
   * created). Null for a system / event-driven create that names its own
   * participants explicitly (TS-070-followup-3 auto-provisioning).
   */
  readonly ensureMemberUserId: string | null;
}

export interface ListInboxInput {
  readonly userId: string;
  readonly limit: number;
  readonly includeArchived: boolean;
}

export interface AddParticipantInput {
  readonly threadId: string;
  readonly requesterUserId: string;
  readonly userId: string;
  readonly role: ThreadParticipantRole;
}

export interface RemoveParticipantInput {
  readonly threadId: string;
  readonly requesterUserId: string;
  readonly userId: string;
}

/**
 * Why a roster mutation was rejected. Maps 1:1 to an HTTP status at the
 * controller boundary:
 *   - `not_a_participant` → 404 (no thread-existence leak — CLAUDE.md §3.2).
 *   - `thread_archived`   → 409 (a closed conversation's roster is frozen).
 *   - `forbidden_role`    → 403 (a read-only observer cannot manage others).
 */
export type RosterGateFailure =
  | { readonly reason: 'not_a_participant' }
  | { readonly reason: 'thread_archived' }
  | { readonly reason: 'forbidden_role' };

/** Postgres unique-violation error code surfaced by Prisma as `P2002`. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * Thread + thread-participant CRUD service (TS-070-followup-2; PRD §6.7; PDD
 * §8.2 + §13.1).
 *
 * Owns the authenticated metadata surface over `messaging.threads` +
 * `messaging.thread_participants`. The trust gate for every operation is the
 * caller's own participation row (CLAUDE.md §3.2): a non-participant sees a
 * thread as if it does not exist. Roster mutations additionally require a
 * *posting* role for the thread kind — a read-only observer cannot change who
 * else is in the conversation (CLAUDE.md §12 family-observability boundaries)
 * — except that any participant may remove *themselves* (leave a thread).
 *
 * Message bodies are out of scope (Cassandra, TS-070-followup-1); this service
 * never reads or writes a message body.
 */
@Injectable()
export class ThreadsService {
  private readonly logger = new Logger(ThreadsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a thread, seeding the supplied participants. `ensureMemberUserId`
   * (the authenticated creator) is added as a `member` if not already named,
   * so the creator can immediately read the thread. The thread row + every
   * participant row are written in one transaction so a membership row is
   * never visible without its parent thread (PDD §13.1).
   */
  async createThread(input: CreateThreadInput): Promise<ThreadWithParticipantsRecord> {
    // Build the seed map keyed by userId so a creator already named in the
    // list keeps their explicit role (we never silently override it).
    const seed = new Map<string, ThreadParticipantRole>();
    for (const p of input.participants) {
      seed.set(p.userId, p.role);
    }
    if (input.ensureMemberUserId !== null && !seed.has(input.ensureMemberUserId)) {
      seed.set(input.ensureMemberUserId, 'member');
    }

    const created = await this.prisma.$transaction(
      async (tx: PrismaTransactionClient): Promise<ThreadWithParticipantsRow> => {
        const thread = (await tx.thread.create({
          data: {
            kind: input.kind,
            householdId: input.householdId,
            bookingId: input.bookingId,
          },
          select: THREAD_SELECT,
        })) as ThreadRow;

        if (seed.size > 0) {
          await tx.threadParticipant.createMany({
            data: [...seed.entries()].map(([userId, role]) => ({
              threadId: thread.id,
              userId,
              role,
            })),
          });
        }

        const participants = (await tx.threadParticipant.findMany({
          where: { threadId: thread.id },
          orderBy: { joinedAt: 'asc' },
          select: PARTICIPANT_SELECT,
        })) as ParticipantRow[];

        return { ...thread, participants };
      },
    );

    this.logger.log(
      {
        threadId: created.id,
        kind: created.kind,
        participantCount: created.participants.length,
      },
      'thread created',
    );
    return toThreadWithParticipants(created);
  }

  /**
   * The caller's inbox — every thread they participate in, newest membership
   * first (index-backed by `thread_participants_user_joined_idx`). Soft-
   * archived threads are excluded unless `includeArchived` is set, mirroring
   * the family-portal default view.
   */
  async listInbox(input: ListInboxInput): Promise<readonly ThreadInboxEntry[]> {
    const rows = (await this.prisma.threadParticipant.findMany({
      where: {
        userId: input.userId,
        ...(input.includeArchived ? {} : { thread: { archivedAt: null } }),
      },
      orderBy: { joinedAt: 'desc' },
      take: input.limit,
      select: {
        role: true,
        lastReadMessageId: true,
        thread: {
          select: {
            ...THREAD_SELECT,
            _count: { select: { participants: true } },
          },
        },
      },
    })) as InboxRow[];

    return rows.map(toInboxEntry);
  }

  /**
   * Thread detail with the full participant list. Returns `null` when the
   * thread does not exist OR the caller is not a participant — the controller
   * maps both to a 404 so thread existence never leaks to a non-member
   * (CLAUDE.md §3.2).
   */
  async getThreadDetailForMember(
    threadId: string,
    requesterUserId: string,
  ): Promise<ThreadWithParticipantsRecord | null> {
    const thread = (await this.prisma.thread.findUnique({
      where: { id: threadId },
      select: {
        ...THREAD_SELECT,
        participants: {
          orderBy: { joinedAt: 'asc' },
          select: PARTICIPANT_SELECT,
        },
      },
    })) as ThreadWithParticipantsRow | null;

    if (thread === null) return null;
    if (!thread.participants.some((p) => p.userId === requesterUserId)) return null;
    return toThreadWithParticipants(thread);
  }

  /**
   * Add a participant. The caller must be a participant holding a posting role
   * for the thread kind, and the thread must not be archived. Idempotent on
   * the roster: re-adding an existing participant is a no-op that returns
   * `already_present` with the existing row (a re-add never silently mutates
   * an existing role).
   */
  async addParticipant(
    input: AddParticipantInput,
  ): Promise<Result<AddThreadParticipantResponse, RosterGateFailure>> {
    const gate = await this.loadManageGate(input.threadId, input.requesterUserId);
    if (!gate.ok) return gate;

    const existing = (await this.prisma.threadParticipant.findUnique({
      where: { threadId_userId: { threadId: input.threadId, userId: input.userId } },
      select: PARTICIPANT_SELECT,
    })) as ParticipantRow | null;
    if (existing !== null) {
      return ok({ participant: toParticipant(existing), outcome: 'already_present' });
    }

    try {
      const created = (await this.prisma.threadParticipant.create({
        data: { threadId: input.threadId, userId: input.userId, role: input.role },
        select: PARTICIPANT_SELECT,
      })) as ParticipantRow;
      this.logger.log(
        { threadId: input.threadId, userId: input.userId, role: input.role },
        'thread participant added',
      );
      return ok({ participant: toParticipant(created), outcome: 'added' });
    } catch (cause) {
      // Lost an add/add race for the same (threadId, userId) — the row now
      // exists, so re-read and report it as already-present (idempotent).
      if (isUniqueViolation(cause)) {
        const row = (await this.prisma.threadParticipant.findUnique({
          where: { threadId_userId: { threadId: input.threadId, userId: input.userId } },
          select: PARTICIPANT_SELECT,
        })) as ParticipantRow | null;
        if (row !== null) {
          return ok({ participant: toParticipant(row), outcome: 'already_present' });
        }
      }
      throw cause;
    }
  }

  /**
   * Remove a participant. Self-removal (a participant leaving a thread) is
   * allowed for any participant regardless of role or archive state. Removing
   * *someone else* requires the caller to hold a posting role on a non-archived
   * thread. Idempotent: removing a non-participant returns `not_present`.
   */
  async removeParticipant(
    input: RemoveParticipantInput,
  ): Promise<Result<RemoveThreadParticipantResponse, RosterGateFailure>> {
    const isSelf = input.userId === input.requesterUserId;

    if (isSelf) {
      const membership = await this.loadMembership(input.threadId, input.requesterUserId);
      if (membership === null) return err({ reason: 'not_a_participant' });
    } else {
      const gate = await this.loadManageGate(input.threadId, input.requesterUserId);
      if (!gate.ok) return gate;
    }

    const target = (await this.prisma.threadParticipant.findUnique({
      where: { threadId_userId: { threadId: input.threadId, userId: input.userId } },
      select: { threadId: true },
    })) as { threadId: string } | null;
    if (target === null) {
      return ok({ outcome: 'not_present', threadId: input.threadId, userId: input.userId });
    }

    await this.prisma.threadParticipant.delete({
      where: { threadId_userId: { threadId: input.threadId, userId: input.userId } },
      select: { threadId: true },
    });
    this.logger.log(
      { threadId: input.threadId, userId: input.userId, removedBy: input.requesterUserId },
      'thread participant removed',
    );
    return ok({ outcome: 'removed', threadId: input.threadId, userId: input.userId });
  }

  /**
   * Resolve the caller's membership row, narrowed to what a roster-management
   * decision needs (the caller's role + the thread's kind + archive state).
   * `null` when the caller is not a participant of the thread.
   */
  private async loadMembership(
    threadId: string,
    userId: string,
  ): Promise<{ role: ThreadParticipantRole; kind: ThreadKind; archivedAt: Date | null } | null> {
    const row = (await this.prisma.threadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId } },
      select: { role: true, thread: { select: { kind: true, archivedAt: true } } },
    })) as {
      role: ThreadParticipantRole;
      thread: { kind: ThreadKind; archivedAt: Date | null };
    } | null;
    if (row === null) return null;
    return { role: row.role, kind: row.thread.kind, archivedAt: row.thread.archivedAt };
  }

  /**
   * The full management gate for mutating *another* user's membership: the
   * caller must be a participant (`not_a_participant`), the thread must be
   * active (`thread_archived`), and the caller must hold a posting role for
   * the thread kind (`forbidden_role`).
   */
  private async loadManageGate(
    threadId: string,
    requesterUserId: string,
  ): Promise<Result<true, RosterGateFailure>> {
    const membership = await this.loadMembership(threadId, requesterUserId);
    if (membership === null) return err({ reason: 'not_a_participant' });
    if (membership.archivedAt !== null) return err({ reason: 'thread_archived' });
    if (!canPostInThread(membership.kind, membership.role)) {
      return err({ reason: 'forbidden_role' });
    }
    return ok(true);
  }
}

// ─── Mappers ────────────────────────────────────────────────────────────

function toParticipant(row: ParticipantRow): ThreadParticipantRecord {
  return {
    threadId: row.threadId,
    userId: row.userId,
    role: row.role,
    joinedAt: row.joinedAt.toISOString(),
    lastReadMessageId: row.lastReadMessageId,
  };
}

function toThreadWithParticipants(row: ThreadWithParticipantsRow): ThreadWithParticipantsRecord {
  return {
    id: row.id,
    kind: row.kind,
    householdId: row.householdId,
    bookingId: row.bookingId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    participants: row.participants.map(toParticipant),
  };
}

function toInboxEntry(row: InboxRow): ThreadInboxEntry {
  return {
    id: row.thread.id,
    kind: row.thread.kind,
    householdId: row.thread.householdId,
    bookingId: row.thread.bookingId,
    createdAt: row.thread.createdAt.toISOString(),
    updatedAt: row.thread.updatedAt.toISOString(),
    archivedAt: row.thread.archivedAt === null ? null : row.thread.archivedAt.toISOString(),
    myRole: row.role,
    myLastReadMessageId: row.lastReadMessageId,
    participantCount: row.thread._count.participants,
  };
}

/**
 * Narrow an unknown thrown value to a Prisma unique-constraint violation
 * (`P2002`) without importing `Prisma.PrismaClientKnownRequestError`
 * (TS-021-followup-2 — the instanceof check resolves inconsistently under our
 * tsconfig, so we duck-type the `code` property).
 */
function isUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === PRISMA_UNIQUE_VIOLATION
  );
}
