import { Injectable, Logger } from '@nestjs/common';
import {
  canTransitionConciergeTicket,
  isConciergeTicketTerminal,
  CONCIERGE_OPS_NOTES_MAX,
  type ConciergeEscalationTarget,
  type ConciergeTicketKind,
  type ConciergeTicketNoteRecord,
  type ConciergeTicketRecord,
  type ConciergeTicketStatus,
} from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

/**
 * Local mirrors of the Prisma-generated rows, narrowed to the columns this
 * module reads / writes. Same TS-021-followup-3 rationale documented across
 * the codebase — Prisma's row types resolve inconsistently under our tsconfig
 * so we project shapes by hand (and each module owns its own projection).
 */
export interface ConciergeTicketRow {
  readonly id: string;
  readonly householdId: string;
  readonly kind: ConciergeTicketRecord['kind'];
  readonly status: ConciergeTicketRecord['status'];
  readonly subject: string;
  readonly body: string;
  readonly requestedDate: Date | null;
  readonly partySize: number | null;
  readonly theme: string | null;
  readonly slaDueAt: Date | null;
  readonly assignedToUserId: string | null;
  readonly escalationPath: ConciergeTicketRecord['escalationPath'];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ConciergeTicketNoteRow {
  readonly id: string;
  readonly ticketId: string;
  readonly authorUserId: string;
  readonly body: string;
  readonly createdAt: Date;
}

/** Explicit column projection — never `SELECT *` (CLAUDE.md §4.1). */
const TICKET_SELECT = {
  id: true,
  householdId: true,
  kind: true,
  status: true,
  subject: true,
  body: true,
  requestedDate: true,
  partySize: true,
  theme: true,
  slaDueAt: true,
  assignedToUserId: true,
  escalationPath: true,
  createdAt: true,
  updatedAt: true,
} as const;

const NOTE_SELECT = {
  id: true,
  ticketId: true,
  authorUserId: true,
  body: true,
  createdAt: true,
} as const;

/** The non-terminal statuses — the default "needs attention" ops queue. */
const ACTIVE_QUEUE_STATUSES: readonly ConciergeTicketStatus[] = [
  'open',
  'assigned',
  'in_progress',
  'escalated',
];

export interface ListOpsQueueInput {
  readonly status?: ConciergeTicketStatus | undefined;
  readonly escalationPath?: ConciergeTicketRecord['escalationPath'] | undefined;
  readonly kind?: ConciergeTicketKind | undefined;
  readonly householdId?: string | undefined;
  readonly limit: number;
}

export interface TransitionTicketInput {
  readonly ticketId: string;
  readonly actorUserId: string;
  readonly targetStatus: ConciergeTicketStatus;
  readonly note?: string | undefined;
}

export interface EscalateTicketInput {
  readonly ticketId: string;
  readonly actorUserId: string;
  readonly escalationPath: ConciergeEscalationTarget;
  readonly note?: string | undefined;
}

export interface AddNoteInput {
  readonly ticketId: string;
  readonly actorUserId: string;
  readonly body: string;
}

export type TransitionOutcome =
  | { readonly ok: true; readonly ticket: ConciergeTicketRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | {
      readonly ok: false;
      readonly reason: 'invalid_transition';
      readonly from: ConciergeTicketStatus;
      readonly to: ConciergeTicketStatus;
    };

export type EscalateOutcome =
  | { readonly ok: true; readonly ticket: ConciergeTicketRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'terminal'; readonly status: ConciergeTicketStatus };

export type AddNoteOutcome =
  | { readonly ok: true; readonly note: ConciergeTicketNoteRecord }
  | { readonly ok: false; readonly reason: 'not_found' };

/**
 * Concierge ops-console service (TS-224; PRD §10.6; PDD §10.6).
 *
 * The back-office side of the concierge ticket lifecycle that TS-223 fills.
 * Owns the admin reads + mutations of `concierge_tickets` and the
 * append-only `concierge_ticket_notes` timeline:
 *
 *   - `listQueue` — the SLA-ordered ops queue across every household
 *     (the actor holds a global scope; defaults to non-terminal tickets).
 *   - `getTicketDetail` — a single ticket plus its notes timeline.
 *   - `transition` — move a ticket through its lifecycle (validated against
 *     the `CONCIERGE_TICKET_STATUS_TRANSITIONS` matrix).
 *   - `escalate` — set the routing path + move the ticket to `escalated`.
 *   - `addNote` — append an internal note.
 *
 * Authorisation lives at the controller boundary: every surface sits behind
 * `AccessTokenGuard` + `PermissionGuard` (`concierge:read` / `concierge:write`).
 * The service trusts the actor id it is handed (resolved from the verified
 * token), the same shape as `AssignmentsService` / `TicketsService`.
 */
@Injectable()
export class OpsConsoleService {
  private readonly logger = new Logger(OpsConsoleService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The ops queue, ordered by SLA proximity (soonest deadline first; tickets
   * with no SLA sort last). With no `status` filter, returns the non-terminal
   * tickets — the "what needs attention" view. Reads across every household
   * (the ops actor's token carries a global scope).
   */
  async listQueue(input: ListOpsQueueInput): Promise<readonly ConciergeTicketRecord[]> {
    const where: Record<string, unknown> = { deletedAt: null };
    where['status'] =
      input.status === undefined ? { in: [...ACTIVE_QUEUE_STATUSES] } : input.status;
    if (input.escalationPath !== undefined) where['escalationPath'] = input.escalationPath;
    if (input.kind !== undefined) where['kind'] = input.kind;
    if (input.householdId !== undefined) where['householdId'] = input.householdId;

    const rows = (await this.prisma.conciergeTicket.findMany({
      where,
      // SLA proximity first; created order as the stable tiebreaker. Postgres
      // sorts NULL `sla_due_at` last on ASC — the desired "no-SLA last".
      orderBy: [{ slaDueAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: input.limit,
      select: TICKET_SELECT,
    })) as ConciergeTicketRow[];
    return rows.map(toTicketRecord);
  }

  /**
   * A single ticket plus its internal-notes timeline (oldest-first). Returns
   * null when the id does not resolve or the ticket is soft-deleted.
   */
  async getTicketDetail(ticketId: string): Promise<{
    ticket: ConciergeTicketRecord;
    notes: readonly ConciergeTicketNoteRecord[];
  } | null> {
    const ticket = (await this.prisma.conciergeTicket.findFirst({
      where: { id: ticketId, deletedAt: null },
      select: TICKET_SELECT,
    })) as ConciergeTicketRow | null;
    if (ticket === null) return null;

    const notes = (await this.prisma.conciergeTicketNote.findMany({
      where: { ticketId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: CONCIERGE_OPS_NOTES_MAX,
      select: NOTE_SELECT,
    })) as ConciergeTicketNoteRow[];

    return { ticket: toTicketRecord(ticket), notes: notes.map(toNoteRecord) };
  }

  /**
   * Move a ticket to `targetStatus`. Validated against the transition matrix
   * from the ticket's CURRENT status; a disallowed move is `invalid_transition`.
   * When `note` is supplied it is appended to the timeline in the same
   * transaction as the status write.
   */
  async transition(input: TransitionTicketInput): Promise<TransitionOutcome> {
    const current = (await this.prisma.conciergeTicket.findFirst({
      where: { id: input.ticketId, deletedAt: null },
      select: { status: true, householdId: true },
    })) as { status: ConciergeTicketStatus; householdId: string } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    if (!canTransitionConciergeTicket(current.status, input.targetStatus)) {
      return {
        ok: false,
        reason: 'invalid_transition',
        from: current.status,
        to: input.targetStatus,
      };
    }

    const updated = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const row = (await tx.conciergeTicket.update({
        where: { id: input.ticketId },
        data: { status: input.targetStatus },
        select: TICKET_SELECT,
      })) as ConciergeTicketRow;
      if (input.note !== undefined) {
        await tx.conciergeTicketNote.create({
          data: {
            ticketId: input.ticketId,
            householdId: current.householdId,
            authorUserId: input.actorUserId,
            body: input.note,
          },
        });
      }
      return row;
    });

    this.logger.log(
      {
        ticketId: input.ticketId,
        actorUserId: input.actorUserId,
        from: current.status,
        to: input.targetStatus,
        noted: input.note !== undefined,
      },
      'concierge ticket transitioned',
    );
    return { ok: true, ticket: toTicketRecord(updated) };
  }

  /**
   * Set the ticket's escalation routing path + move it to `escalated`.
   * Escalating a terminal (resolved / canceled) ticket is `terminal`.
   * Re-escalating an already-escalated ticket to a different path is allowed.
   */
  async escalate(input: EscalateTicketInput): Promise<EscalateOutcome> {
    const current = (await this.prisma.conciergeTicket.findFirst({
      where: { id: input.ticketId, deletedAt: null },
      select: { status: true, householdId: true },
    })) as { status: ConciergeTicketStatus; householdId: string } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    if (isConciergeTicketTerminal(current.status)) {
      return { ok: false, reason: 'terminal', status: current.status };
    }

    const updated = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const row = (await tx.conciergeTicket.update({
        where: { id: input.ticketId },
        data: { status: 'escalated', escalationPath: input.escalationPath },
        select: TICKET_SELECT,
      })) as ConciergeTicketRow;
      if (input.note !== undefined) {
        await tx.conciergeTicketNote.create({
          data: {
            ticketId: input.ticketId,
            householdId: current.householdId,
            authorUserId: input.actorUserId,
            body: input.note,
          },
        });
      }
      return row;
    });

    this.logger.log(
      {
        ticketId: input.ticketId,
        actorUserId: input.actorUserId,
        from: current.status,
        escalationPath: input.escalationPath,
        noted: input.note !== undefined,
      },
      'concierge ticket escalated',
    );
    return { ok: true, ticket: toTicketRecord(updated) };
  }

  /** Append an internal note to a ticket. `not_found` when the ticket is gone. */
  async addNote(input: AddNoteInput): Promise<AddNoteOutcome> {
    const ticket = (await this.prisma.conciergeTicket.findFirst({
      where: { id: input.ticketId, deletedAt: null },
      select: { householdId: true },
    })) as { householdId: string } | null;
    if (ticket === null) return { ok: false, reason: 'not_found' };

    const created = (await this.prisma.conciergeTicketNote.create({
      data: {
        ticketId: input.ticketId,
        householdId: ticket.householdId,
        authorUserId: input.actorUserId,
        body: input.body,
      },
      select: NOTE_SELECT,
    })) as ConciergeTicketNoteRow;

    this.logger.log(
      { ticketId: input.ticketId, actorUserId: input.actorUserId, noteId: created.id },
      'concierge ticket note added',
    );
    return { ok: true, note: toNoteRecord(created) };
  }
}

/** Project a persisted ticket row into the wire `ConciergeTicketRecord`. */
function toTicketRecord(row: ConciergeTicketRow): ConciergeTicketRecord {
  return {
    id: row.id,
    householdId: row.householdId,
    kind: row.kind,
    status: row.status,
    subject: row.subject,
    body: row.body,
    requestedDate: row.requestedDate === null ? null : row.requestedDate.toISOString().slice(0, 10),
    partySize: row.partySize,
    theme: row.theme,
    slaDueAt: row.slaDueAt === null ? null : row.slaDueAt.toISOString(),
    assignedToUserId: row.assignedToUserId,
    escalationPath: row.escalationPath,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project a persisted note row into the wire `ConciergeTicketNoteRecord`. */
function toNoteRecord(row: ConciergeTicketNoteRow): ConciergeTicketNoteRecord {
  return {
    id: row.id,
    ticketId: row.ticketId,
    authorUserId: row.authorUserId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}
