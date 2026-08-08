import { Injectable, Logger } from '@nestjs/common';
import {
  canTransitionConciergeRide,
  isConciergeRideTerminal,
  type ConciergeRideStatus,
  type ConciergeRideStatusWebhookOutcome,
  type ConciergeTransportationProvider,
  type ConciergeTransportationRequestRecord,
  type InitialConciergeRideStatus,
  type ScheduleConciergeTransportationRequest,
  type UpdateConciergeTransportationRequest,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';
import { mapVendorRideStatus } from './ride-status-adapter';

/**
 * Local mirror of the Prisma-generated `concierge_transportation_requests`
 * row, narrowed to the columns this module reads / writes. Same
 * TS-021-followup-3 rationale documented across the codebase — Prisma's row
 * types resolve inconsistently under our tsconfig so we project shapes by hand
 * (dropped on the next Prisma bump — TS-226-followup).
 */
export interface ConciergeTransportationRequestRow {
  readonly id: string;
  readonly householdId: string;
  readonly ticketId: string | null;
  readonly status: ConciergeRideStatus;
  readonly externalProvider: ConciergeTransportationProvider;
  readonly pickupAddress: string;
  readonly dropoffAddress: string;
  readonly scheduledPickupAt: Date;
  readonly purpose: string | null;
  readonly riderName: string | null;
  readonly externalReference: string | null;
  readonly externalStatus: string | null;
  readonly notes: string | null;
  readonly createdByUserId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Explicit column projection — never `SELECT *` (CLAUDE.md §4.1). */
const RIDE_SELECT = {
  id: true,
  householdId: true,
  ticketId: true,
  status: true,
  externalProvider: true,
  pickupAddress: true,
  dropoffAddress: true,
  scheduledPickupAt: true,
  purpose: true,
  riderName: true,
  externalReference: true,
  externalStatus: true,
  notes: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface ScheduleRideInput extends ScheduleConciergeTransportationRequest {
  /** The concierge arranging the ride — from the verified token. */
  readonly actorUserId: string;
}

export interface ListRidesInput {
  readonly householdId?: string | undefined;
  readonly ticketId?: string | undefined;
  readonly status?: ConciergeRideStatus | undefined;
  readonly externalProvider?: ConciergeTransportationProvider | undefined;
  readonly upcomingOnly?: boolean | undefined;
  readonly limit: number;
}

export interface UpdateRideInput extends UpdateConciergeTransportationRequest {
  readonly requestId: string;
  readonly actorUserId: string;
}

export type ScheduleRideOutcome =
  | { readonly ok: true; readonly request: ConciergeTransportationRequestRecord }
  | { readonly ok: false; readonly reason: 'ticket_not_found' }
  | { readonly ok: false; readonly reason: 'ticket_household_mismatch' };

export type UpdateRideOutcome =
  | { readonly ok: true; readonly request: ConciergeTransportationRequestRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'terminal'; readonly status: ConciergeRideStatus }
  | {
      readonly ok: false;
      readonly reason: 'invalid_transition';
      readonly from: ConciergeRideStatus;
      readonly to: ConciergeRideStatus;
    };

export interface RideWebhookInput {
  readonly externalProvider: ConciergeTransportationProvider;
  readonly externalReference: string;
  readonly externalStatus: string;
  readonly occurredAt: string;
}

export interface RideWebhookOutcome {
  readonly outcome: ConciergeRideStatusWebhookOutcome;
  readonly status: ConciergeRideStatus | null;
}

/**
 * Concierge transportation-coordination service (TS-226; PRD §5.1 Tier 3
 * "transportation coordination", §6.6; PDD §10.6).
 *
 * The fulfilment side of a Tier-3 household's transportation need: a concierge
 * arranges the concrete booked ride (pickup / dropoff / scheduled time),
 * tracks its lifecycle, and overrides / cancels it.
 *
 *   - `scheduleRide` — persist a new ride; when a `ticketId` is supplied,
 *     verify in-service that the ticket exists and belongs to the SAME
 *     household (both tables live in the `concierge` schema — no cross-service
 *     read, CLAUDE.md §2.3).
 *   - `listRides` — rides ordered by `scheduledPickupAt` ascending, filterable
 *     by household / originating ticket / status / provider / upcoming-only.
 *   - `updateRide` — partial update / override / cancel; a status change is
 *     validated against the `CONCIERGE_RIDE_STATUS_TRANSITIONS` matrix; a
 *     terminal ride rejects all edits.
 *   - `applyWebhookEvent` — the inbound ride-status webhook path. Matches a
 *     ride by (provider, external reference), maps the raw vendor status onto
 *     the domain lifecycle via the adapter, and mirrors it back. The vendor is
 *     authoritative, so this bypasses the concierge transition matrix — but it
 *     still refuses to mutate a terminal ride.
 *
 * Authorisation lives at the controller boundary: the admin surfaces sit behind
 * `AccessTokenGuard` + `PermissionGuard` (`concierge:read` / `concierge:write`);
 * the webhook sits behind the shared-secret guard. The service trusts the actor
 * id it is handed (resolved from the verified token), the same shape as
 * `ScheduledEventsService`.
 */
@Injectable()
export class TransportationService {
  private readonly logger = new Logger(TransportationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Arrange a new ride for a household. When `ticketId` is supplied the
   * originating ticket must exist (not soft-deleted) and belong to the same
   * household — otherwise `ticket_not_found` / `ticket_household_mismatch`.
   */
  async scheduleRide(input: ScheduleRideInput): Promise<ScheduleRideOutcome> {
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

    const created = (await this.prisma.conciergeTransportationRequest.create({
      data: {
        householdId: input.householdId,
        ticketId: input.ticketId ?? null,
        status: input.status satisfies InitialConciergeRideStatus,
        externalProvider: input.externalProvider,
        pickupAddress: input.pickupAddress,
        dropoffAddress: input.dropoffAddress,
        scheduledPickupAt: new Date(input.scheduledPickupAt),
        purpose: input.purpose ?? null,
        riderName: input.riderName ?? null,
        externalReference: input.externalReference ?? null,
        notes: input.notes ?? null,
        createdByUserId: input.actorUserId,
      },
      select: RIDE_SELECT,
    })) as ConciergeTransportationRequestRow;

    this.logger.log(
      {
        requestId: created.id,
        householdId: created.householdId,
        ticketId: created.ticketId,
        status: created.status,
        externalProvider: created.externalProvider,
        actorUserId: input.actorUserId,
      },
      'concierge transportation request scheduled',
    );
    return { ok: true, request: toRecord(created) };
  }

  /** Matching rides ordered by `scheduledPickupAt` ascending (soonest first). */
  async listRides(input: ListRidesInput): Promise<readonly ConciergeTransportationRequestRecord[]> {
    const where: Record<string, unknown> = { deletedAt: null };
    if (input.householdId !== undefined) where['householdId'] = input.householdId;
    if (input.ticketId !== undefined) where['ticketId'] = input.ticketId;
    if (input.status !== undefined) where['status'] = input.status;
    if (input.externalProvider !== undefined) where['externalProvider'] = input.externalProvider;
    if (input.upcomingOnly === true) where['scheduledPickupAt'] = { gte: new Date() };

    const rows = (await this.prisma.conciergeTransportationRequest.findMany({
      where,
      orderBy: [{ scheduledPickupAt: 'asc' }, { id: 'asc' }],
      take: input.limit,
      select: RIDE_SELECT,
    })) as ConciergeTransportationRequestRow[];
    return rows.map(toRecord);
  }

  /**
   * Apply a partial update. Resolution order:
   *   1. `not_found` — the ride does not resolve (or is soft-deleted).
   *   2. `terminal` — a completed / canceled ride rejects all edits.
   *   3. `invalid_transition` — a `status` change disallowed by the matrix.
   * Only then does the write fire.
   */
  async updateRide(input: UpdateRideInput): Promise<UpdateRideOutcome> {
    const current = (await this.prisma.conciergeTransportationRequest.findFirst({
      where: { id: input.requestId, deletedAt: null },
      select: { status: true },
    })) as { status: ConciergeRideStatus } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    if (isConciergeRideTerminal(current.status)) {
      return { ok: false, reason: 'terminal', status: current.status };
    }

    // Status transition (only when it actually changes — a same-status PATCH
    // alongside other field edits is a no-op for status).
    if (input.status !== undefined && input.status !== current.status) {
      if (!canTransitionConciergeRide(current.status, input.status)) {
        return { ok: false, reason: 'invalid_transition', from: current.status, to: input.status };
      }
    }

    const data: Record<string, unknown> = {};
    if (input.pickupAddress !== undefined) data['pickupAddress'] = input.pickupAddress;
    if (input.dropoffAddress !== undefined) data['dropoffAddress'] = input.dropoffAddress;
    if (input.scheduledPickupAt !== undefined) {
      data['scheduledPickupAt'] = new Date(input.scheduledPickupAt);
    }
    if (input.purpose !== undefined) data['purpose'] = input.purpose;
    if (input.riderName !== undefined) data['riderName'] = input.riderName;
    if (input.externalReference !== undefined) data['externalReference'] = input.externalReference;
    if (input.notes !== undefined) data['notes'] = input.notes;
    if (input.status !== undefined && input.status !== current.status)
      data['status'] = input.status;

    const updated = (await this.prisma.conciergeTransportationRequest.update({
      where: { id: input.requestId },
      data,
      select: RIDE_SELECT,
    })) as ConciergeTransportationRequestRow;

    this.logger.log(
      {
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        from: current.status,
        to: updated.status,
        fields: Object.keys(data),
      },
      'concierge transportation request updated',
    );
    return { ok: true, request: toRecord(updated) };
  }

  /**
   * Apply an inbound vendor ride-status webhook event. Looks up the ride by
   * (provider, external reference), maps the raw vendor status onto the domain
   * lifecycle, and mirrors it back. Outcomes:
   *   - `not_found` — no non-deleted ride matches (provider, reference).
   *   - `already_terminal` — the ride is completed / canceled; no change (the
   *     raw status is still recorded for the audit trail).
   *   - `unrecognized_status` — the raw status has no domain mapping; the raw
   *     value is stored but the domain status is left unchanged.
   *   - `unchanged` — the mapped status equals the current one (only the raw
   *     status is refreshed).
   *   - `applied` — the domain status changed to the mapped value.
   * The vendor is authoritative, so a recognised status is applied directly
   * (bypassing the concierge transition matrix) — except on a terminal ride.
   */
  async applyWebhookEvent(input: RideWebhookInput): Promise<RideWebhookOutcome> {
    const current = (await this.prisma.conciergeTransportationRequest.findFirst({
      where: {
        externalProvider: input.externalProvider,
        externalReference: input.externalReference,
        deletedAt: null,
      },
      select: { id: true, status: true },
    })) as { id: string; status: ConciergeRideStatus } | null;

    if (current === null) {
      this.logger.warn(
        {
          externalProvider: input.externalProvider,
          externalReference: input.externalReference,
          externalStatus: input.externalStatus,
        },
        'concierge transportation webhook — no matching ride',
      );
      return { outcome: 'not_found', status: null };
    }

    if (isConciergeRideTerminal(current.status)) {
      // Still record the raw status for the audit trail, but never resurrect a
      // completed / canceled ride.
      await this.prisma.conciergeTransportationRequest.update({
        where: { id: current.id },
        data: { externalStatus: input.externalStatus },
      });
      return { outcome: 'already_terminal', status: current.status };
    }

    const mapped = mapVendorRideStatus(input.externalProvider, input.externalStatus);
    if (mapped === null) {
      await this.prisma.conciergeTransportationRequest.update({
        where: { id: current.id },
        data: { externalStatus: input.externalStatus },
      });
      this.logger.warn(
        {
          requestId: current.id,
          externalProvider: input.externalProvider,
          externalStatus: input.externalStatus,
        },
        'concierge transportation webhook — unrecognised vendor status',
      );
      return { outcome: 'unrecognized_status', status: current.status };
    }

    if (mapped === current.status) {
      await this.prisma.conciergeTransportationRequest.update({
        where: { id: current.id },
        data: { externalStatus: input.externalStatus },
      });
      return { outcome: 'unchanged', status: current.status };
    }

    await this.prisma.conciergeTransportationRequest.update({
      where: { id: current.id },
      data: { status: mapped, externalStatus: input.externalStatus },
    });
    this.logger.log(
      {
        requestId: current.id,
        externalProvider: input.externalProvider,
        from: current.status,
        to: mapped,
        externalStatus: input.externalStatus,
        occurredAt: input.occurredAt,
      },
      'concierge transportation webhook — ride status mirrored',
    );
    return { outcome: 'applied', status: mapped };
  }
}

/** Project a persisted row into the wire `ConciergeTransportationRequestRecord`. */
function toRecord(row: ConciergeTransportationRequestRow): ConciergeTransportationRequestRecord {
  return {
    id: row.id,
    householdId: row.householdId,
    ticketId: row.ticketId,
    status: row.status,
    externalProvider: row.externalProvider,
    pickupAddress: row.pickupAddress,
    dropoffAddress: row.dropoffAddress,
    scheduledPickupAt: row.scheduledPickupAt.toISOString(),
    purpose: row.purpose,
    riderName: row.riderName,
    externalReference: row.externalReference,
    externalStatus: row.externalStatus,
    notes: row.notes,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
