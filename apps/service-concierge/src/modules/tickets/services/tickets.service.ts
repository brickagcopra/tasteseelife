import { Injectable, Logger } from '@nestjs/common';
import {
  resolveConciergeTicketSlaHours,
  type ConciergeTicketRecord,
  type FamilySubmittableConciergeTicketKind,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Local mirror of the Prisma-generated `concierge_tickets` row, narrowed to
 * the columns this module reads / writes. Same TS-021-followup-3 rationale
 * documented across the codebase — Prisma's row types resolve
 * inconsistently under our tsconfig so we project shapes by hand.
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
  readonly deletedAt: Date | null;
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
  deletedAt: true,
} as const;

const MS_PER_HOUR = 60 * 60 * 1000;

export interface SubmitConciergeRequestInput {
  readonly householdId: string;
  readonly kind: FamilySubmittableConciergeTicketKind;
  readonly subject: string;
  readonly body: string;
  /** Optional requested calendar date, `YYYY-MM-DD`. */
  readonly requestedDate: string | null;
  readonly partySize: number | null;
  readonly theme: string | null;
}

export interface ListConciergeTicketsInput {
  readonly householdId: string;
  readonly limit: number;
}

/**
 * Concierge custom-request / service-request service (TS-223; PRD §6.6;
 * PDD §10.6).
 *
 * Owns the family-side submission + read of `concierge_tickets`:
 *   - `submitRequest` — persist a new service request, route it to the
 *     household's active dedicated concierge (the TS-222 primary, when one
 *     exists — an IN-SERVICE lookup since both tables live in the
 *     `concierge` schema, no cross-service read), and stamp an SLA deadline
 *     from the per-kind policy.
 *   - `listForHousehold` — the household's submitted requests, newest-first.
 *
 * Row-level authorisation lives at the controller boundary: every surface
 * sits behind `AccessTokenGuard` and resolves the household from the
 * token's `tenantScope` claim; the service trusts the household id it is
 * handed (the same shape as `AssignmentsService`).
 */
@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Submit a concierge service request for a household. Routes to the
   * household's active primary concierge when one is assigned
   * (`status='assigned'`); otherwise the ticket lands `open` in the
   * unassigned ops queue (TS-224). `sla_due_at` is `now + the per-kind
   * policy hours`.
   */
  async submitRequest(input: SubmitConciergeRequestInput): Promise<ConciergeTicketRecord> {
    // In-service lookup of the household's active dedicated concierge — both
    // tables live in the `concierge` schema, so this is NOT a cross-service
    // read (CLAUDE.md §2.3). A null result simply means the household has no
    // dedicated concierge yet (non-Tier-3, or awaiting kickoff).
    const assignment = (await this.prisma.conciergeAssignment.findFirst({
      where: { householdId: input.householdId, status: 'active', deletedAt: null },
      select: { primaryConciergeUserId: true },
    })) as { primaryConciergeUserId: string } | null;

    const assignedToUserId = assignment?.primaryConciergeUserId ?? null;
    const status = assignedToUserId === null ? 'open' : 'assigned';

    const now = new Date();
    const slaDueAt = new Date(
      now.getTime() + resolveConciergeTicketSlaHours(input.kind) * MS_PER_HOUR,
    );

    const created = (await this.prisma.conciergeTicket.create({
      data: {
        householdId: input.householdId,
        kind: input.kind,
        status,
        subject: input.subject,
        body: input.body,
        requestedDate: parseRequestedDate(input.requestedDate),
        partySize: input.partySize,
        theme: input.theme,
        slaDueAt,
        assignedToUserId,
        escalationPath: 'standard',
      },
      select: TICKET_SELECT,
    })) as ConciergeTicketRow;

    this.logger.log(
      {
        householdId: input.householdId,
        ticketId: created.id,
        kind: created.kind,
        status: created.status,
        routed: assignedToUserId !== null,
      },
      'concierge request submitted',
    );
    return toRecord(created);
  }

  /** The household's submitted requests, newest-first. */
  async listForHousehold(
    input: ListConciergeTicketsInput,
  ): Promise<readonly ConciergeTicketRecord[]> {
    const rows = (await this.prisma.conciergeTicket.findMany({
      where: { householdId: input.householdId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: input.limit,
      select: TICKET_SELECT,
    })) as ConciergeTicketRow[];
    return rows.map(toRecord);
  }
}

/**
 * Convert an optional `YYYY-MM-DD` wire date into a `Date` at UTC midnight
 * for the `@db.Date` column (Prisma stores the date component only).
 */
function parseRequestedDate(value: string | null): Date | null {
  if (value === null) return null;
  return new Date(`${value}T00:00:00.000Z`);
}

/** Project a persisted row into the wire `ConciergeTicketRecord`. */
function toRecord(row: ConciergeTicketRow): ConciergeTicketRecord {
  return {
    id: row.id,
    householdId: row.householdId,
    kind: row.kind,
    status: row.status,
    subject: row.subject,
    body: row.body,
    // `@db.Date` rows come back at UTC midnight; project the date component.
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
