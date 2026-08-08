import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { isAdminRoleName } from '@taste-and-see/auth-sdk';
import {
  BOOKING_DISPUTE_OPENED,
  BOOKING_DISPUTE_RESOLVED,
  type BookingDisputeOpenedByRole,
  type BookingDisputeOutcome,
  type BookingDisputeReason,
  type OpenBookingDisputeRequest,
  type TransitionableBookingDisputeStatus,
  type UpdateBookingDisputeRequest,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { err, ok, type Result } from '../../../common/result';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import type { BookingStatus } from '../../lifecycle/booking-status';

/**
 * Local mirror of the Prisma-generated `BookingDispute` row.
 *
 * Same TS-021-followup-2 / TS-021-followup-3 root cause documented
 * across the codebase — Prisma 5.22's namespace value-side resolves
 * inconsistently under our `verbatimModuleSyntax: false` /
 * `isolatedModules: true` tsconfig. Mirrors `BookingRecord` /
 * `VisitNoteRecord` / `CheckInRecord` shape. Drops when Prisma
 * 5.23 / 6.x lands (captured as a TS-065-followup alongside the
 * sibling cleanups).
 */
export interface DisputeRecord {
  readonly id: string;
  readonly bookingId: string;
  readonly openedByUserId: string;
  readonly openedByRole: BookingDisputeOpenedByRole;
  readonly reason: BookingDisputeReason;
  readonly reasonDetail: string | null;
  readonly status: DisputeStatus;
  readonly resolutionNotes: string | null;
  readonly resolvedByUserId: string | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Dispute lifecycle status — mirrors the Prisma
 * `booking_dispute_status` enum. Local mirror for the same root
 * cause documented on `DisputeRecord`.
 */
export type DisputeStatus = 'open' | 'under_review' | 'resolved' | 'dismissed';

export interface OpenDisputeInput {
  readonly actorUserId: string;
  readonly actorRoleNames: readonly string[];
  readonly bookingId: string;
  readonly request: OpenBookingDisputeRequest;
}

export interface GetDisputeInput {
  readonly actorUserId: string;
  readonly disputeId: string;
}

export interface ListDisputesInput {
  readonly actorUserId: string;
  readonly bookingId: string;
}

export interface UpdateDisputeInput {
  readonly actorUserId: string;
  readonly disputeId: string;
  readonly request: UpdateBookingDisputeRequest;
}

/**
 * Failure shapes returned by `DisputesService`. Mirrors the
 * discriminated-union pattern used elsewhere in service-booking
 * (CLAUDE.md §2.1) so the controller can switch exhaustively to the
 * HTTP status.
 */
export type DisputesServiceFailure =
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'booking_not_found'; readonly bookingId: string }
  | { readonly reason: 'dispute_not_found'; readonly disputeId: string }
  | {
      readonly reason: 'invalid_booking_status';
      readonly bookingStatus: BookingStatus;
      readonly allowed: readonly BookingStatus[];
    }
  | {
      readonly reason: 'invalid_status_transition';
      readonly from: DisputeStatus;
      readonly to: DisputeStatus;
      readonly allowed: readonly DisputeStatus[];
    }
  | { readonly reason: 'resolution_notes_required' }
  | { readonly reason: 'outbox_validation_failed'; readonly message: string };

/**
 * Booking statuses that permit opening a dispute. A `pending` booking
 * has not yet been confirmed by the provider so there is no service
 * rendered to dispute — the family-portal should cancel the booking
 * instead (`PATCH /api/v1/bookings/:id/status` with `targetStatus: 'canceled'`).
 * Every other status (confirmed / in_progress / completed / canceled)
 * may legitimately attract a dispute (e.g. provider didn't show up
 * after confirming → no_show; or refund dispute on a canceled booking).
 */
const DISPUTE_OPEN_ALLOWED_BOOKING_STATUSES: readonly BookingStatus[] = [
  'confirmed',
  'in_progress',
  'completed',
  'canceled',
];

/**
 * Dispute status transition matrix (TS-065). Mirrors the four-state
 * machine documented on the Prisma enum:
 *
 *   open         → under_review, resolved, dismissed
 *   under_review → resolved, dismissed
 *   resolved     → (terminal, no outgoing)
 *   dismissed    → (terminal, no outgoing)
 *
 * The contract layer's `TransitionableBookingDisputeStatusSchema`
 * already excludes `open` as a target — the API never lets a caller
 * flip a dispute back to `open`. The matrix below is the
 * service-layer source of truth that the controller calls into via
 * `validateStatusTransition`.
 */
const DISPUTE_STATUS_TRANSITIONS: Readonly<Record<DisputeStatus, readonly DisputeStatus[]>> =
  Object.freeze({
    open: ['under_review', 'resolved', 'dismissed'],
    under_review: ['resolved', 'dismissed'],
    resolved: [],
    dismissed: [],
  });

/**
 * Booking dispute orchestration (TS-065; PRD §10.5).
 *
 * Four operations covering the dispute lifecycle:
 *
 *   - `openDispute({ actorUserId, actorRoleNames, bookingId, request })`
 *     — inserts a new `booking_disputes` row in `open` and emits a
 *     `booking.dispute_opened` event through the outbox in the same
 *     Prisma `$transaction`. The opener role is derived server-side
 *     from `actorRoleNames` (no client-supplied role — CLAUDE.md
 *     §3.2). The booking must exist AND be in a status that permits
 *     a dispute (everything except `pending`).
 *
 *   - `getById({ actorUserId, disputeId })` — reads a single dispute
 *     row by id. Row-level access (CLAUDE.md §3.2) is a thin marker
 *     today — TS-065-followup-1 captures the household / provider
 *     match check (a family observer can only see disputes on
 *     bookings in their household; a provider can only see disputes
 *     on bookings they're assigned to).
 *
 *   - `listByBookingId({ actorUserId, bookingId })` — returns every
 *     dispute row for a booking ordered by `createdAt` ascending.
 *     The family-portal renders the chronological timeline; admin
 *     tooling uses it for triage.
 *
 *   - `updateDispute({ actorUserId, disputeId, request })` —
 *     transitions the dispute status against the matrix. When
 *     transitioning to a terminal state (`resolved` / `dismissed`),
 *     `resolutionNotes` is required AND the service stamps
 *     `resolvedByUserId` + `resolvedAt` server-side. Emits
 *     `booking.dispute_resolved` on the terminal transition.
 *
 * **Outbox + transactional invariants.** Both `openDispute` and the
 * terminal `updateDispute` path run inside `prisma.$transaction` so
 * the row mutation + the outbox event commit atomically — consumers
 * never see a dispute opened without the matching event (or vice
 * versa). The `under_review` path is a single UPDATE without an
 * outbox event (no consumer cares about the intermediate state
 * change in Phase 1; an event can be added additively later).
 *
 * **Cross-service identifiers**. The dispute event payload carries
 * `householdId` + `providerId` (soft FKs into household / provider
 * service schemas) so consumers can route on them without joining
 * back to the booking row through the gateway BFF. The service reads
 * those ids off the parent booking row at event-construction time.
 *
 * **Row-level access** — today the service trusts the controller's
 * authenticated `actorUserId` (the established Phase-1 booking
 * pattern, mirrored from `BookingsService` / `VisitNotesService` /
 * `CheckInsService`). TS-141's Prisma extension will push enforcement
 * down a layer so the controller cannot bypass it; TS-065-followup
 * captures the actor / household / provider match checks.
 */
@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async openDispute(
    input: OpenDisputeInput,
  ): Promise<Result<DisputeRecord, DisputesServiceFailure>> {
    if (input.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }
    if (input.bookingId.length === 0) {
      return err({ reason: 'invalid_request', message: 'bookingId is required' });
    }

    const booking = (await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
      select: {
        id: true,
        status: true,
        householdId: true,
        providerId: true,
      },
    })) as {
      id: string;
      status: BookingStatus;
      householdId: string;
      providerId: string;
    } | null;
    if (booking === null) {
      return err({ reason: 'booking_not_found', bookingId: input.bookingId });
    }
    if (!DISPUTE_OPEN_ALLOWED_BOOKING_STATUSES.includes(booking.status)) {
      return err({
        reason: 'invalid_booking_status',
        bookingStatus: booking.status,
        allowed: DISPUTE_OPEN_ALLOWED_BOOKING_STATUSES,
      });
    }

    const openedByRole = resolveOpenerRole(input.actorRoleNames);
    const now = new Date();
    const id = `dsp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    // Resolved to an explicit `string | null` rather than a conditional
    // spread: `...(cond && { reasonDetail })` leaves the property typed
    // `string | undefined`, and under `exactOptionalPropertyTypes` a
    // present-but-`undefined` property is not assignable to the generated
    // `reasonDetail?: string | null` input (TS-501). The column is
    // nullable, so an omitted/blank detail is simply NULL.
    const reasonDetail =
      input.request.reasonDetail !== undefined && input.request.reasonDetail.length > 0
        ? input.request.reasonDetail
        : null;

    try {
      const created = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const row = (await tx.bookingDispute.create({
          data: {
            id,
            bookingId: booking.id,
            openedByUserId: input.actorUserId,
            openedByRole,
            reason: input.request.reason,
            reasonDetail,
            status: 'open',
          },
        })) as unknown as DisputeRecord;

        const appendResult = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
          eventName: BOOKING_DISPUTE_OPENED,
          payload: {
            eventId: `${id}.opened.${now.getTime()}`,
            occurredAt: now.toISOString(),
            disputeId: row.id,
            bookingId: booking.id,
            householdId: booking.householdId,
            providerId: booking.providerId,
            openedByUserId: row.openedByUserId,
            openedByRole: row.openedByRole,
            reason: row.reason,
            hasReasonDetail: reasonDetail !== null,
          },
        });
        if (appendResult.kind !== 'appended') {
          throw new OutboxValidationFailedError(appendResult.eventName, appendResult.issues);
        }
        return row;
      });

      this.logger.log(
        `booking.dispute_opened disputeId=${created.id} bookingId=${booking.id} reason=${created.reason} openedByRole=${created.openedByRole}`,
      );
      return ok(created);
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(`booking.dispute_open outbox validation failed: ${e.message}`);
        return err({
          reason: 'outbox_validation_failed',
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }

  async getById(input: GetDisputeInput): Promise<Result<DisputeRecord, DisputesServiceFailure>> {
    if (input.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }
    if (input.disputeId.length === 0) {
      return err({ reason: 'invalid_request', message: 'disputeId is required' });
    }

    const row = (await this.prisma.bookingDispute.findUnique({
      where: { id: input.disputeId },
    })) as unknown as DisputeRecord | null;
    if (row === null) {
      return err({ reason: 'dispute_not_found', disputeId: input.disputeId });
    }

    this.logger.debug(
      `dispute.read disputeId=${row.id} actorUserId=${input.actorUserId} status=${row.status}`,
    );
    return ok(row);
  }

  async listByBookingId(
    input: ListDisputesInput,
  ): Promise<Result<readonly DisputeRecord[], DisputesServiceFailure>> {
    if (input.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }
    if (input.bookingId.length === 0) {
      return err({ reason: 'invalid_request', message: 'bookingId is required' });
    }

    const booking = (await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
      select: { id: true },
    })) as { id: string } | null;
    if (booking === null) {
      return err({ reason: 'booking_not_found', bookingId: input.bookingId });
    }

    const rows = (await this.prisma.bookingDispute.findMany({
      where: { bookingId: booking.id },
      orderBy: { createdAt: 'asc' },
    })) as unknown as readonly DisputeRecord[];

    this.logger.debug(
      `dispute.list bookingId=${booking.id} actorUserId=${input.actorUserId} count=${rows.length}`,
    );
    return ok(rows);
  }

  async updateDispute(
    input: UpdateDisputeInput,
  ): Promise<Result<DisputeRecord, DisputesServiceFailure>> {
    if (input.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }
    if (input.disputeId.length === 0) {
      return err({ reason: 'invalid_request', message: 'disputeId is required' });
    }

    const existing = (await this.prisma.bookingDispute.findUnique({
      where: { id: input.disputeId },
    })) as unknown as DisputeRecord | null;
    if (existing === null) {
      return err({ reason: 'dispute_not_found', disputeId: input.disputeId });
    }

    const targetStatus: DisputeStatus = input.request.targetStatus;
    const allowed = DISPUTE_STATUS_TRANSITIONS[existing.status];
    if (!allowed.includes(targetStatus)) {
      return err({
        reason: 'invalid_status_transition',
        from: existing.status,
        to: targetStatus,
        allowed,
      });
    }

    const isTerminal = targetStatus === 'resolved' || targetStatus === 'dismissed';
    const resolutionNotes = input.request.resolutionNotes ?? null;
    if (isTerminal && (resolutionNotes === null || resolutionNotes.length === 0)) {
      // Defence-in-depth — the contract layer's superRefine already
      // catches this, but the service repeats the check so a future
      // non-HTTP caller (e.g. an admin script) gets the same gate.
      return err({ reason: 'resolution_notes_required' });
    }

    const now = new Date();

    // Look up the parent booking for the resolved-event payload's
    // household / provider identifiers. Only needed on the terminal
    // path — under_review transitions don't emit an event today.
    let booking: { householdId: string; providerId: string } | null = null;
    if (isTerminal) {
      booking = (await this.prisma.booking.findUnique({
        where: { id: existing.bookingId },
        select: { householdId: true, providerId: true },
      })) as { householdId: string; providerId: string } | null;
      if (booking === null) {
        // Should be unreachable — the booking row cannot be deleted
        // while a dispute references it. Defence-in-depth.
        return err({ reason: 'booking_not_found', bookingId: existing.bookingId });
      }
    }

    try {
      const updated = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const row = (await tx.bookingDispute.update({
          where: { id: existing.id },
          data: {
            status: targetStatus,
            ...(isTerminal && {
              resolutionNotes,
              resolvedByUserId: input.actorUserId,
              resolvedAt: now,
            }),
          },
        })) as unknown as DisputeRecord;

        if (isTerminal && booking !== null) {
          const outcome: BookingDisputeOutcome =
            targetStatus === 'resolved' ? 'resolved' : 'dismissed';
          const appendResult = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
            eventName: BOOKING_DISPUTE_RESOLVED,
            payload: {
              eventId: `${row.id}.resolved.${now.getTime()}`,
              occurredAt: now.toISOString(),
              disputeId: row.id,
              bookingId: row.bookingId,
              householdId: booking.householdId,
              providerId: booking.providerId,
              outcome,
              resolvedByUserId: input.actorUserId,
              reason: row.reason,
              hasResolutionNotes: row.resolutionNotes !== null && row.resolutionNotes.length > 0,
            },
          });
          if (appendResult.kind !== 'appended') {
            throw new OutboxValidationFailedError(appendResult.eventName, appendResult.issues);
          }
        }
        return row;
      });

      this.logger.log(
        `dispute.transition disputeId=${updated.id} ${existing.status} -> ${updated.status}`,
      );
      return ok(updated);
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(`dispute.update outbox validation failed: ${e.message}`);
        return err({
          reason: 'outbox_validation_failed',
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }
}

/**
 * Map the actor's role assignments to the categorical opener role
 * stored on the dispute row. Mirrors the order documented in
 * `auth-sdk`'s `holdsAdminRole`:
 *
 *   - any admin-staff role → `admin` (uses `isAdminRoleName` from
 *     `@taste-and-see/auth-sdk` so the admin/non-admin split stays
 *     centralised — PDD §10.2)
 *   - `provider` role → `provider`
 *   - else → `family` (covers `family_payer` / `family_observer` /
 *     `senior_user` and the default for any custom non-staff role)
 *
 * The check is `O(roles.length)` — Phase-1 tokens carry at most a
 * handful of role assignments so this stays cheap.
 */
function resolveOpenerRole(roleNames: readonly string[]): BookingDisputeOpenedByRole {
  let sawProvider = false;
  for (const name of roleNames) {
    if (isAdminRoleName(name)) return 'admin';
    if (name === 'provider') sawProvider = true;
  }
  return sawProvider ? 'provider' : 'family';
}

/**
 * Surface an outbox validation failure as a typed exception so the
 * Prisma `$transaction` rolls back — the dispute row + outbox event
 * invariant holds (PDD §7.3).
 */
class OutboxValidationFailedError extends Error {
  constructor(
    readonly eventName: string,
    readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(
      `outbox.append validation failed for ${eventName}: ${issues
        .map((i) => i.message)
        .join('; ')}`,
    );
    this.name = 'OutboxValidationFailedError';
  }
}

/**
 * Re-export the transition-target type so the controller can type
 * the request body field without duplicate imports.
 */
export type DisputeTargetStatus = TransitionableBookingDisputeStatus;
