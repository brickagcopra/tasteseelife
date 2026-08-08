import { Injectable, Logger } from '@nestjs/common';
import {
  resolveConciergeTicketSlaHours,
  type ConciergeEmergencyCategory,
  type ConciergeTicketRecord,
} from '@taste-and-see/contracts';
import { PagerDutyClient } from '@taste-and-see/nest-pagerduty';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Local mirror of the Prisma-generated `concierge_tickets` row, narrowed to
 * the columns this module reads / writes. Same TS-021-followup-3 rationale
 * documented across the codebase — Prisma's row types resolve
 * inconsistently under our tsconfig so we project shapes by hand (the
 * sibling `TicketsService` / `OpsConsoleService` carry the same mirror).
 */
interface ConciergeTicketRow {
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

const MS_PER_HOUR = 60 * 60 * 1000;

/** Body stamped when the family triggers an emergency without a note. */
const DEFAULT_EMERGENCY_BODY =
  'Emergency assistance requested via the family portal. No additional details were provided.';

/** Human-readable ticket subject per triage category. */
const EMERGENCY_SUBJECT_BY_CATEGORY: Record<ConciergeEmergencyCategory, string> = {
  medical: 'Emergency assistance — Medical concern',
  safety: 'Emergency assistance — Safety concern',
  urgent_need: 'Emergency assistance — Urgent need',
  other: 'Emergency assistance',
};

export interface TriggerEmergencyInput {
  readonly householdId: string;
  readonly category: ConciergeEmergencyCategory;
  /** Optional free-text context; null when the family triggered bare. */
  readonly note: string | null;
}

/**
 * Emergency concierge-assistance service (TS-225; PRD §5.1 Tier 3; PDD
 * §16.1, §20.5).
 *
 * `triggerEmergency` is the distinct, high-severity counterpart of the
 * TS-223 custom-request flow:
 *
 *   1. Look up the household's active dedicated concierge (an IN-SERVICE
 *      `concierge_assignments` read — both tables live in the `concierge`
 *      schema, no cross-service read; CLAUDE.md §2.3) so the ticket routes
 *      to a named owner when one exists.
 *   2. Persist a `concierge_tickets` row opened directly at `escalated` on
 *      the `emergency_on_call` path with the tightened 1-hour SLA — it lands
 *      at the very top of the TS-224 ops queue.
 *   3. AFTER the ticket commits, page the on-call supervisor via PagerDuty
 *      (best-effort — the durable ticket is the source of truth; a paging
 *      failure is logged + would be metered, never rolled back).
 *
 * Row-level authorisation lives at the controller boundary: the surface sits
 * behind `AccessTokenGuard` and resolves the household from the token's
 * `tenantScope` claim; the service trusts the household id it is handed (the
 * same shape as `TicketsService` / `AssignmentsService`).
 *
 * No Tier-3 hard gate — emergency assistance is a safety surface reachable
 * by any household (the cross-service tier read is deferred across the
 * concierge surfaces; TS-223-followup-3 / TS-222-followup-3).
 */
@Injectable()
export class EmergencyService {
  private readonly logger = new Logger(EmergencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pagerDuty: PagerDutyClient,
  ) {}

  async triggerEmergency(input: TriggerEmergencyInput): Promise<ConciergeTicketRecord> {
    // In-service lookup of the household's active dedicated concierge. A null
    // result simply means the household has no dedicated concierge (e.g. a
    // non-Tier-3 family using the safety surface) — the ticket lands
    // unassigned in the escalated queue and on-call is still paged.
    const assignment = (await this.prisma.conciergeAssignment.findFirst({
      where: { householdId: input.householdId, status: 'active', deletedAt: null },
      select: { primaryConciergeUserId: true },
    })) as { primaryConciergeUserId: string } | null;

    const assignedToUserId = assignment?.primaryConciergeUserId ?? null;

    const now = new Date();
    const slaDueAt = new Date(
      now.getTime() + resolveConciergeTicketSlaHours('emergency_assistance') * MS_PER_HOUR,
    );

    // Open the ticket directly at `escalated` on the `emergency_on_call`
    // path. An emergency bypasses the normal open→assigned→in_progress
    // ramp — the ops console surfaces it immediately and on-call is paged.
    const created = (await this.prisma.conciergeTicket.create({
      data: {
        householdId: input.householdId,
        kind: 'emergency_assistance',
        status: 'escalated',
        subject: EMERGENCY_SUBJECT_BY_CATEGORY[input.category],
        body: input.note ?? DEFAULT_EMERGENCY_BODY,
        requestedDate: null,
        partySize: null,
        theme: null,
        slaDueAt,
        assignedToUserId,
        escalationPath: 'emergency_on_call',
      },
      select: TICKET_SELECT,
    })) as ConciergeTicketRow;

    this.logger.warn(
      {
        householdId: input.householdId,
        ticketId: created.id,
        category: input.category,
        routed: assignedToUserId !== null,
      },
      'emergency concierge assistance triggered',
    );

    // Page on-call AFTER the ticket has committed. Best-effort: the ticket is
    // already the durable source of truth, so a paging failure never rolls
    // back the write or fails the family's request.
    await this.page(created.id, input, assignedToUserId, slaDueAt);

    return toRecord(created);
  }

  /** Fire the PagerDuty page and log the outcome. Never throws. */
  private async page(
    ticketId: string,
    input: TriggerEmergencyInput,
    assignedToUserId: string | null,
    slaDueAt: Date,
  ): Promise<void> {
    const result = await this.pagerDuty.enqueue({
      // The note is deliberately NOT in the payload (it may carry PII the
      // family typed in the moment) — the responder opens the ops-console
      // ticket for the detail.
      dedupKey: `concierge-emergency-${ticketId}`,
      summary: `[Taste & See] Emergency concierge (${input.category}) — ticket ${ticketId}`,
      severity: 'critical',
      customDetails: {
        ticketId,
        householdId: input.householdId,
        category: input.category,
        assignedConciergeUserId: assignedToUserId ?? 'unassigned',
        slaDueAt: slaDueAt.toISOString(),
        opsConsole: `/concierge/tickets/${ticketId}`,
      },
    });

    switch (result.kind) {
      case 'sent':
        this.logger.log(
          { ticketId, dedupKey: result.dedupKey },
          'emergency concierge page dispatched to PagerDuty',
        );
        break;
      case 'skipped_unconfigured':
        this.logger.warn(
          { ticketId },
          'PagerDuty routing key not configured — emergency ticket escalated but on-call was NOT paged',
        );
        break;
      case 'failed':
        this.logger.error(
          { ticketId, detail: result.detail },
          'emergency concierge PagerDuty page FAILED — ticket is escalated; on-call must be reached manually',
        );
        break;
    }
  }
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
