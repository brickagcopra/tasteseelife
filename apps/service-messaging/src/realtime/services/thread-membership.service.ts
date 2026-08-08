import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { ThreadKind, ThreadParticipantRole } from '../thread-posting-policy';

/**
 * Resolved membership row returned by `resolveMembership`. The shape
 * is narrowed from the Prisma model to the fields the realtime layer
 * actually needs (role + thread-kind + thread-archived gate).
 * Cross-service ids (`userId`, `threadId`) are TEXT per CLAUDE.md §2.3.
 *
 * `kind` is surfaced (TS-209) so the publish-time posting gate can call
 * `canPostInThread(kind, role)` from `thread-posting-policy` once the
 * `message:send` handler lands (TS-209-followup-3, blocked on the
 * Cassandra body store TS-070-followup-1). The join gate itself is
 * kind-agnostic — any participant on a non-archived thread may join the
 * room; posting is the policy-gated action.
 */
export interface ResolvedMembership {
  readonly threadId: string;
  readonly userId: string;
  readonly kind: ThreadKind;
  readonly role: ThreadParticipantRole;
  /** Wall-clock soft-archive timestamp from the parent thread row. */
  readonly threadArchivedAt: Date | null;
}

/**
 * Verifies a user's participation in a thread before the realtime
 * gateway lets them join the room.
 *
 * The trust gate for the messaging surface is the explicit
 * `messaging.thread_participants` row — CLAUDE.md §3.2 row-level checks
 * on every read. A user with a valid access token but no participant
 * row gets a 403-equivalent (a `thread:join:error` ack) rather than
 * silent admission. Observers (`role = observer`) join the same room
 * as members; the read-only constraint is enforced at the publish path
 * (a future `message:send` handler will reject from-observers — TS-071
 * ships read-only delivery so observers and members are
 * indistinguishable on the wire today).
 *
 * Soft-archived threads (`threadArchivedAt IS NOT NULL`) are rejected
 * — the family-portal default view hides them, and the realtime layer
 * mirrors that hide so a stale browser tab doesn't keep receiving
 * traffic for a closed conversation.
 *
 * No tenant-scoping Prisma extension yet (TS-141 lands the extension);
 * the participant-row lookup is itself the row-level gate for the
 * messaging context.
 */
@Injectable()
export class ThreadMembershipService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveMembership(threadId: string, userId: string): Promise<ResolvedMembership | null> {
    const row = await this.prisma.threadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId } },
      select: {
        threadId: true,
        userId: true,
        role: true,
        thread: { select: { archivedAt: true, kind: true } },
      },
    });
    if (row === null) return null;
    return {
      threadId: row.threadId,
      userId: row.userId,
      kind: row.thread.kind,
      role: row.role,
      threadArchivedAt: row.thread.archivedAt,
    };
  }
}
