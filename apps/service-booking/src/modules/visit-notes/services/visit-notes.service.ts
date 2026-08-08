import { Injectable, Logger } from '@nestjs/common';
import type {
  UpsertVisitNotesRequest,
  VisitNoteAppetite,
  VisitNoteHydration,
  VisitNoteMood,
  VisitNoteSocialEngagement,
} from '@taste-and-see/contracts';

import { err, ok, type Result } from '../../../common/result';
import { PrismaService } from '../../../prisma/prisma.service';
import type { BookingStatus } from '../../lifecycle/booking-status';

/**
 * Local mirror of the Prisma-generated `BookingVisitNote` row.
 *
 * Same TS-021-followup-2 / TS-021-followup-3 root cause documented
 * across the codebase — Prisma 5.22's namespace value-side resolves
 * inconsistently under our `verbatimModuleSyntax: false` /
 * `isolatedModules: true` tsconfig. Mirrors `BookingRecord` in
 * `bookings.service.ts`. Drops when Prisma 5.23 / 6.x lands (see
 * TS-062-followup tracking sibling cleanups).
 */
export interface VisitNoteRecord {
  readonly id: string;
  readonly bookingId: string;
  readonly mood: VisitNoteMood | null;
  readonly appetite: VisitNoteAppetite | null;
  readonly hydration: VisitNoteHydration | null;
  readonly socialEngagement: VisitNoteSocialEngagement | null;
  readonly freeform: string | null;
  readonly photoKeys: readonly string[];
  readonly recordedByUserId: string;
  readonly recordedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UpsertVisitNotesInput {
  readonly actorUserId: string;
  readonly bookingId: string;
  readonly request: UpsertVisitNotesRequest;
}

export interface GetVisitNotesInput {
  readonly actorUserId: string;
  readonly bookingId: string;
}

/**
 * Failure shapes returned by `VisitNotesService`. Mirrors the
 * discriminated-union pattern used elsewhere in service-booking
 * (CLAUDE.md §2.1) so the controller can switch exhaustively to
 * the HTTP status.
 */
export type VisitNotesServiceFailure =
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'booking_not_found'; readonly bookingId: string }
  | { readonly reason: 'visit_notes_not_found'; readonly bookingId: string }
  | {
      readonly reason: 'invalid_lifecycle_state';
      readonly bookingStatus: BookingStatus;
      readonly allowed: readonly BookingStatus[];
    };

/**
 * Statuses where the provider is permitted to write visit notes.
 * PDD §9.2 — notes are recorded during the visit (in_progress) and
 * may be edited up to and including the transition into `completed`.
 * Earlier states (pending, confirmed) reject because the visit has
 * not started; the terminal `canceled` state has no notes (the visit
 * didn't happen). The `completed` state is included so the provider
 * can correct a note immediately after check-out (a windowed edit
 * policy lands in TS-062-followup if product requires a stricter
 * gate).
 */
const VISIT_NOTES_WRITE_ALLOWED_STATUSES: readonly BookingStatus[] = ['in_progress', 'completed'];

/**
 * Visit-notes orchestration (TS-062).
 *
 * Three responsibilities:
 *
 *   - `upsert({ actorUserId, bookingId, request })` — UPSERTs the
 *     visit-notes row for a booking. The first save inserts; later
 *     saves update. The booking-status gate (see
 *     `VISIT_NOTES_WRITE_ALLOWED_STATUSES`) is enforced server-side,
 *     not at the controller.
 *
 *   - `getByBookingId({ actorUserId, bookingId })` — reads the
 *     visit-notes row for a booking. Returns `visit_notes_not_found`
 *     when the booking exists but the provider hasn't yet submitted
 *     a note — the family-portal renders an empty-state placeholder.
 *
 *   - Row-level access — today the service trusts the controller's
 *     authenticated `actorUserId` (the established Phase-1 booking
 *     pattern, mirrored from `BookingsService`). TS-141's Prisma
 *     extension will push enforcement down a layer so the controller
 *     cannot bypass it; TS-062-followup-1 captures the actor /
 *     provider match check (a provider can only write notes for
 *     their own assigned booking).
 *
 * **No outbox today**. The visit notes do not emit a domain event in
 * this slice — the wellness-summary email (PRD §6.9) reads visit
 * notes on-demand from a query, not from a stream. A
 * `booking.visit_notes_recorded` event is captured as TS-062-followup
 * so the trust-safety welfare-signal worker (PDD §16.1) has a named
 * subscription point when persistently `none`/`poor`/`withdrawn`
 * patterns need to flag.
 */
@Injectable()
export class VisitNotesService {
  private readonly logger = new Logger(VisitNotesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsert(
    input: UpsertVisitNotesInput,
  ): Promise<Result<VisitNoteRecord, VisitNotesServiceFailure>> {
    if (input.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }
    if (input.bookingId.length === 0) {
      return err({ reason: 'invalid_request', message: 'bookingId is required' });
    }

    const booking = (await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
      select: { id: true, status: true },
    })) as { id: string; status: BookingStatus } | null;
    if (booking === null) {
      return err({ reason: 'booking_not_found', bookingId: input.bookingId });
    }
    if (!VISIT_NOTES_WRITE_ALLOWED_STATUSES.includes(booking.status)) {
      return err({
        reason: 'invalid_lifecycle_state',
        bookingStatus: booking.status,
        allowed: VISIT_NOTES_WRITE_ALLOWED_STATUSES,
      });
    }

    const now = new Date();
    const writePayload = buildWritePayload(input.request, input.actorUserId, now);

    // Upsert keyed on the UNIQUE `bookingId` index. A concurrent
    // double-PUT lands at most one row total — the second call's
    // `create` would hit P2002 and the `update` path takes over.
    const row = (await this.prisma.bookingVisitNote.upsert({
      where: { bookingId: booking.id },
      create: {
        bookingId: booking.id,
        ...writePayload,
      },
      update: {
        ...writePayload,
      },
    })) as unknown as VisitNoteRecord;

    this.logger.log(
      `visit_notes.upserted bookingId=${row.bookingId} actorUserId=${input.actorUserId} status=${booking.status}`,
    );
    return ok(row);
  }

  async getByBookingId(
    input: GetVisitNotesInput,
  ): Promise<Result<VisitNoteRecord, VisitNotesServiceFailure>> {
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

    const row = (await this.prisma.bookingVisitNote.findUnique({
      where: { bookingId: booking.id },
    })) as unknown as VisitNoteRecord | null;
    if (row === null) {
      return err({ reason: 'visit_notes_not_found', bookingId: booking.id });
    }

    this.logger.debug(
      `visit_notes.read bookingId=${row.bookingId} actorUserId=${input.actorUserId}`,
    );
    return ok(row);
  }
}

/**
 * Build the create + update payload from the request body. Every
 * field that is `undefined` in the request is treated as "not
 * supplied → don't touch on update"; explicit `null` clears the
 * field. The contract's `.superRefine` already rejects a fully-empty
 * payload at the wire so the row never reaches this function in the
 * degenerate all-null shape.
 *
 * `photoKeys` defaults to `[]` at the schema layer; we always write
 * the array (the contract resolves it to `[]` on omit so the column
 * stays consistent).
 */
function buildWritePayload(
  request: UpsertVisitNotesRequest,
  actorUserId: string,
  now: Date,
): {
  readonly mood: VisitNoteMood | null;
  readonly appetite: VisitNoteAppetite | null;
  readonly hydration: VisitNoteHydration | null;
  readonly socialEngagement: VisitNoteSocialEngagement | null;
  readonly freeform: string | null;
  // Mutable copy: Prisma's generated scalar-list input is `string[]`,
  // which a `readonly string[]` is not assignable to (TS-501).
  readonly photoKeys: string[];
  readonly recordedByUserId: string;
  readonly recordedAt: Date;
} {
  // Omitted structured fields normalise to `null`, not `undefined`.
  //
  // The endpoint is a PUT and this one payload is spread into BOTH the
  // `create` and the `update` arm of the upsert, so full-replacement is
  // the intended semantic. Leaving `undefined` in place made the two arms
  // disagree: on `create` Prisma writes NULL, but on `update` `undefined`
  // means "leave this column unchanged" — so re-PUTting a note without
  // `mood` silently kept the previous mood instead of clearing it.
  // `exactOptionalPropertyTypes` rejects `undefined` against the generated
  // `T | null` input, which is what surfaced this (TS-501).
  return {
    mood: request.mood ?? null,
    appetite: request.appetite ?? null,
    hydration: request.hydration ?? null,
    socialEngagement: request.socialEngagement ?? null,
    freeform: request.freeform ?? null,
    photoKeys: [...request.photoKeys],
    recordedByUserId: actorUserId,
    recordedAt: now,
  };
}
