import { Injectable, Logger } from '@nestjs/common';
import {
  canTransitionConciergeEvent,
  isConciergeEventTerminal,
  type ConciergeEventExternalProvider,
  type ConciergeEventKind,
  type ConciergeEventStatus,
  type ConciergeScheduledEventRecord,
  type InitialConciergeEventStatus,
  type ScheduleConciergeEventRequest,
  type UpdateConciergeEventRequest,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Local mirror of the Prisma-generated `concierge_scheduled_events` row,
 * narrowed to the columns this module reads / writes. Same TS-021-followup-3
 * rationale documented across the codebase — Prisma's row types resolve
 * inconsistently under our tsconfig so we project shapes by hand (dropped on
 * the next Prisma bump — TS-227-followup-9).
 */
export interface ConciergeScheduledEventRow {
  readonly id: string;
  readonly householdId: string;
  readonly ticketId: string | null;
  readonly kind: ConciergeEventKind;
  readonly status: ConciergeEventStatus;
  readonly title: string;
  readonly venueName: string | null;
  readonly venueAddress: string | null;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date | null;
  readonly partySize: number | null;
  readonly externalProvider: ConciergeEventExternalProvider;
  readonly externalReference: string | null;
  readonly notes: string | null;
  readonly createdByUserId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Explicit column projection — never `SELECT *` (CLAUDE.md §4.1). */
const EVENT_SELECT = {
  id: true,
  householdId: true,
  ticketId: true,
  kind: true,
  status: true,
  title: true,
  venueName: true,
  venueAddress: true,
  scheduledStart: true,
  scheduledEnd: true,
  partySize: true,
  externalProvider: true,
  externalReference: true,
  notes: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface ScheduleEventInput extends ScheduleConciergeEventRequest {
  /** The concierge scheduling the event — from the verified token. */
  readonly actorUserId: string;
}

export interface ListEventsInput {
  readonly householdId?: string | undefined;
  readonly ticketId?: string | undefined;
  readonly status?: ConciergeEventStatus | undefined;
  readonly kind?: ConciergeEventKind | undefined;
  readonly upcomingOnly?: boolean | undefined;
  readonly limit: number;
}

export interface UpdateEventInput extends UpdateConciergeEventRequest {
  readonly eventId: string;
  readonly actorUserId: string;
}

export type ScheduleEventOutcome =
  | { readonly ok: true; readonly event: ConciergeScheduledEventRecord }
  | { readonly ok: false; readonly reason: 'ticket_not_found' }
  | { readonly ok: false; readonly reason: 'ticket_household_mismatch' };

export type UpdateEventOutcome =
  | { readonly ok: true; readonly event: ConciergeScheduledEventRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'terminal'; readonly status: ConciergeEventStatus }
  | {
      readonly ok: false;
      readonly reason: 'invalid_transition';
      readonly from: ConciergeEventStatus;
      readonly to: ConciergeEventStatus;
    }
  | { readonly ok: false; readonly reason: 'invalid_time_range' };

/**
 * Concierge scheduled-events service (TS-227; PRD §5.1 Tier 3 "social
 * outings · event dining", §6.6; PDD §10.6).
 *
 * The fulfilment side of the concierge ticket lifecycle: a concierge schedules
 * the concrete booked experience (restaurant reservation / cultural event /
 * group outing) that satisfies a household request.
 *
 *   - `scheduleEvent` — persist a new event; when a `ticketId` is supplied,
 *     verify in-service that the ticket exists and belongs to the SAME
 *     household (both tables live in the `concierge` schema — no cross-service
 *     read, CLAUDE.md §2.3).
 *   - `listEvents` — events ordered by `scheduledStart` ascending, filterable
 *     by household / originating ticket / status / kind / upcoming-only.
 *   - `updateEvent` — partial update; a status change is validated against the
 *     `CONCIERGE_EVENT_STATUS_TRANSITIONS` matrix; a terminal event rejects
 *     all edits; the merged start/end pair is re-checked.
 *
 * Authorisation lives at the controller boundary: every surface sits behind
 * `AccessTokenGuard` + `PermissionGuard` (`concierge:read` / `concierge:write`).
 * The service trusts the actor id it is handed (resolved from the verified
 * token), the same shape as `OpsConsoleService`.
 */
@Injectable()
export class ScheduledEventsService {
  private readonly logger = new Logger(ScheduledEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Schedule a new event for a household. When `ticketId` is supplied the
   * originating ticket must exist (not soft-deleted) and belong to the same
   * household — otherwise `ticket_not_found` / `ticket_household_mismatch`.
   */
  async scheduleEvent(input: ScheduleEventInput): Promise<ScheduleEventOutcome> {
    if (input.ticketId !== undefined) {
      const ticket = (await this.prisma.conciergeTicket.findFirst({
        where: { id: input.ticketId, deletedAt: null },
        select: { householdId: true },
      })) as { householdId: string } | null;
      if (ticket === null) return { ok: false, reason: 'ticket_not_found' };
      if (ticket.householdId !== input.householdId) {
        return { ok: false, reason: 'ticket_household_mismatch' };
      }
    }

    const created = (await this.prisma.conciergeScheduledEvent.create({
      data: {
        householdId: input.householdId,
        ticketId: input.ticketId ?? null,
        kind: input.kind,
        status: input.status satisfies InitialConciergeEventStatus,
        title: input.title,
        venueName: input.venueName ?? null,
        venueAddress: input.venueAddress ?? null,
        scheduledStart: new Date(input.scheduledStart),
        scheduledEnd: input.scheduledEnd === undefined ? null : new Date(input.scheduledEnd),
        partySize: input.partySize ?? null,
        externalProvider: input.externalProvider,
        externalReference: input.externalReference ?? null,
        notes: input.notes ?? null,
        createdByUserId: input.actorUserId,
      },
      select: EVENT_SELECT,
    })) as ConciergeScheduledEventRow;

    this.logger.log(
      {
        eventId: created.id,
        householdId: created.householdId,
        ticketId: created.ticketId,
        kind: created.kind,
        status: created.status,
        actorUserId: input.actorUserId,
      },
      'concierge event scheduled',
    );
    return { ok: true, event: toRecord(created) };
  }

  /** Matching events ordered by `scheduledStart` ascending (soonest first). */
  async listEvents(input: ListEventsInput): Promise<readonly ConciergeScheduledEventRecord[]> {
    const where: Record<string, unknown> = { deletedAt: null };
    if (input.householdId !== undefined) where['householdId'] = input.householdId;
    if (input.ticketId !== undefined) where['ticketId'] = input.ticketId;
    if (input.status !== undefined) where['status'] = input.status;
    if (input.kind !== undefined) where['kind'] = input.kind;
    if (input.upcomingOnly === true) where['scheduledStart'] = { gte: new Date() };

    const rows = (await this.prisma.conciergeScheduledEvent.findMany({
      where,
      orderBy: [{ scheduledStart: 'asc' }, { id: 'asc' }],
      take: input.limit,
      select: EVENT_SELECT,
    })) as ConciergeScheduledEventRow[];
    return rows.map(toRecord);
  }

  /**
   * Apply a partial update. Resolution order:
   *   1. `not_found` — the event does not resolve (or is soft-deleted).
   *   2. `terminal` — a completed / canceled event rejects all edits.
   *   3. `invalid_transition` — a `status` change disallowed by the matrix.
   *   4. `invalid_time_range` — the merged start/end pair is non-monotonic.
   * Only then does the write fire.
   */
  async updateEvent(input: UpdateEventInput): Promise<UpdateEventOutcome> {
    const current = (await this.prisma.conciergeScheduledEvent.findFirst({
      where: { id: input.eventId, deletedAt: null },
      select: { status: true, scheduledStart: true, scheduledEnd: true },
    })) as { status: ConciergeEventStatus; scheduledStart: Date; scheduledEnd: Date | null } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    if (isConciergeEventTerminal(current.status)) {
      return { ok: false, reason: 'terminal', status: current.status };
    }

    // Status transition (only when it actually changes — a same-status PATCH
    // alongside other field edits is a no-op for status).
    if (input.status !== undefined && input.status !== current.status) {
      if (!canTransitionConciergeEvent(current.status, input.status)) {
        return { ok: false, reason: 'invalid_transition', from: current.status, to: input.status };
      }
    }

    // Re-check the merged start/end pair after applying the partial.
    const effectiveStart =
      input.scheduledStart !== undefined ? new Date(input.scheduledStart) : current.scheduledStart;
    const effectiveEnd =
      input.scheduledEnd !== undefined
        ? input.scheduledEnd === null
          ? null
          : new Date(input.scheduledEnd)
        : current.scheduledEnd;
    if (effectiveEnd !== null && effectiveEnd.getTime() <= effectiveStart.getTime()) {
      return { ok: false, reason: 'invalid_time_range' };
    }

    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data['title'] = input.title;
    if (input.venueName !== undefined) data['venueName'] = input.venueName;
    if (input.venueAddress !== undefined) data['venueAddress'] = input.venueAddress;
    if (input.scheduledStart !== undefined) data['scheduledStart'] = new Date(input.scheduledStart);
    if (input.scheduledEnd !== undefined) {
      data['scheduledEnd'] = input.scheduledEnd === null ? null : new Date(input.scheduledEnd);
    }
    if (input.partySize !== undefined) data['partySize'] = input.partySize;
    if (input.externalProvider !== undefined) data['externalProvider'] = input.externalProvider;
    if (input.externalReference !== undefined) data['externalReference'] = input.externalReference;
    if (input.notes !== undefined) data['notes'] = input.notes;
    if (input.status !== undefined && input.status !== current.status)
      data['status'] = input.status;

    const updated = (await this.prisma.conciergeScheduledEvent.update({
      where: { id: input.eventId },
      data,
      select: EVENT_SELECT,
    })) as ConciergeScheduledEventRow;

    this.logger.log(
      {
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        from: current.status,
        to: updated.status,
        fields: Object.keys(data),
      },
      'concierge event updated',
    );
    return { ok: true, event: toRecord(updated) };
  }
}

/** Project a persisted row into the wire `ConciergeScheduledEventRecord`. */
function toRecord(row: ConciergeScheduledEventRow): ConciergeScheduledEventRecord {
  return {
    id: row.id,
    householdId: row.householdId,
    ticketId: row.ticketId,
    kind: row.kind,
    status: row.status,
    title: row.title,
    venueName: row.venueName,
    venueAddress: row.venueAddress,
    scheduledStart: row.scheduledStart.toISOString(),
    scheduledEnd: row.scheduledEnd === null ? null : row.scheduledEnd.toISOString(),
    partySize: row.partySize,
    externalProvider: row.externalProvider,
    externalReference: row.externalReference,
    notes: row.notes,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
