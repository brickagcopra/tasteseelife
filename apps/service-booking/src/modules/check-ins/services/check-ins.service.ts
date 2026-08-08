import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  BOOKING_COMPLETED,
  BOOKING_IN_PROGRESS,
  type BookingCheckInKind,
  type EventName,
  type RecordBookingCheckInRequest,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { err, ok, type Result } from '../../../common/result';
import { BookingMetrics } from '../../../observability/booking-metrics';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import { buildTransitionEventPayload } from '../../lifecycle/build-transition-event-payload';
import { BookingLifecycleService } from '../../lifecycle/booking-lifecycle.service';
import type { BookingStatus } from '../../lifecycle/booking-status';
import type { BookingRecord } from '../../bookings/services/bookings.service';

/**
 * Local mirror of the Prisma-generated `BookingCheckIn` row.
 *
 * Same TS-021-followup-2 / TS-021-followup-3 root cause documented
 * across the codebase — Prisma 5.22's namespace value-side resolves
 * inconsistently under our `verbatimModuleSyntax: false` /
 * `isolatedModules: true` tsconfig. Mirrors `VisitNoteRecord` in
 * `visit-notes.service.ts`. Drops when Prisma 5.23 / 6.x lands
 * (see TS-063-followup tracking sibling cleanups).
 */
export interface CheckInRecord {
  readonly id: string;
  readonly bookingId: string;
  readonly kind: BookingCheckInKind;
  /** `Decimal(8,6)` stringly-typed boundary value. */
  readonly latitude: { toString(): string };
  /** `Decimal(9,6)` stringly-typed boundary value. */
  readonly longitude: { toString(): string };
  /** `Decimal(10,2)` stringly-typed; null when device did not surface accuracy. */
  readonly locationAccuracyMeters: { toString(): string } | null;
  readonly occurredAt: Date;
  readonly recordedByUserId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RecordCheckInInput {
  readonly actorUserId: string;
  readonly bookingId: string;
  readonly request: RecordBookingCheckInRequest;
}

export interface ListCheckInsInput {
  readonly actorUserId: string;
  readonly bookingId: string;
}

/**
 * The trio returned by a successful `record(...)` call — the new
 * check-in row + the updated booking (the same row with its new
 * `status` and, on `check_out`, the new `completedAt` stamp). Returned
 * as a discriminated success carrying both so the controller can
 * compose the `{ checkIn, booking }` response without a second
 * round-trip to fetch the booking.
 */
export interface RecordCheckInOutput {
  readonly checkIn: CheckInRecord;
  readonly booking: BookingRecord;
}

/**
 * Failure shapes returned by `CheckInsService`. Mirrors the
 * discriminated-union pattern used elsewhere in service-booking
 * (CLAUDE.md §2.1) so the controller can switch exhaustively to
 * the HTTP status.
 */
export type CheckInsServiceFailure =
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'booking_not_found'; readonly bookingId: string }
  | {
      readonly reason: 'invalid_lifecycle_state';
      readonly bookingStatus: BookingStatus;
      readonly requiredStatus: BookingStatus;
      readonly kind: BookingCheckInKind;
    }
  | {
      readonly reason: 'already_recorded';
      readonly bookingId: string;
      readonly kind: BookingCheckInKind;
    }
  | {
      /**
       * TS-302e — the booking is suspended by a trust & safety hold and the
       * provider tried to START the visit. See `assertHoldPermits` for why
       * this fires on `check_in` and deliberately never on `check_out`.
       */
      readonly reason: 'booking_held';
      readonly bookingId: string;
      readonly kind: BookingCheckInKind;
    }
  | { readonly reason: 'outbox_validation_failed'; readonly message: string };

/**
 * Map each check-in `kind` to the booking lifecycle status the
 * booking must be in to accept it, plus the destination status the
 * record operation transitions to.
 *
 * PRD §7.4 + PDD §9.2:
 *   - `check_in`  consumes `confirmed`   → produces `in_progress`.
 *   - `check_out` consumes `in_progress` → produces `completed`.
 *
 * Declared as a frozen const tuple so adding a future kind (e.g.
 * "step_out" / "step_back_in" for multi-segment visits — out of
 * scope for Phase 1) is a structural change that requires touching
 * this table.
 */
const CHECK_IN_TRANSITION: Readonly<
  Record<BookingCheckInKind, { readonly from: BookingStatus; readonly to: BookingStatus }>
> = Object.freeze({
  check_in: { from: 'confirmed', to: 'in_progress' },
  check_out: { from: 'in_progress', to: 'completed' },
});

/**
 * Booking check-ins orchestration (TS-063; PRD §7.4 + PDD §9.2).
 *
 * Two responsibilities:
 *
 *   - `record({ actorUserId, bookingId, request })` — inserts a
 *     `booking_check_ins` row AND transitions the parent booking
 *     status AND appends the matching `booking.*` outbox event, all
 *     in one Prisma `$transaction`. The lifecycle gate is enforced
 *     server-side using `BookingLifecycleService.validateTransition`
 *     so the matrix that bounds legal transitions stays in one place.
 *
 *   - `listByBookingId({ actorUserId, bookingId })` — returns every
 *     check-in row for a booking ordered by `occurredAt` ascending.
 *     The family-portal + provider-portal render the chronological
 *     timeline; admin tooling uses it for ops triage.
 *
 * **Atomic.** The check-in row, the booking row UPDATE, and the
 * outbox event INSERT all commit together. A consumer that sees
 * `booking.completed` is guaranteed that the matching `check_out`
 * row exists and the booking's `status = 'completed'` /
 * `completedAt` stamp is set.
 *
 * **UNIQUE handling.** Postgres raises `23505` (and Prisma raises
 * `P2002`) when a concurrent double-POST collides on the
 * `(booking_id, kind)` UNIQUE index. The service catches it and
 * surfaces a typed `already_recorded` failure (HTTP 409). The
 * dominant retry-safety path is the `@Idempotent()` controller
 * cache; the UNIQUE constraint is the second line of defence.
 *
 * **Row-level access** — today the service trusts the controller's
 * authenticated `actorUserId` (the established Phase-1 booking
 * pattern, mirrored from `BookingsService` / `VisitNotesService`).
 * TS-141's Prisma extension will push enforcement down a layer so
 * the controller cannot bypass it; TS-063-followup captures the
 * actor / provider match check (a provider can only record check-ins
 * for their own assigned booking).
 */
@Injectable()
export class CheckInsService {
  private readonly logger = new Logger(CheckInsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: BookingLifecycleService,
    private readonly outbox: OutboxService,
    private readonly metrics: BookingMetrics,
  ) {}

  async record(
    input: RecordCheckInInput,
  ): Promise<Result<RecordCheckInOutput, CheckInsServiceFailure>> {
    // `CHECK_IN_TRANSITION` is keyed on every `BookingCheckInKind`
    // value (the const tuple is exhaustive); the `!` documents that
    // the table contains an entry for every variant of the enum and
    // dodges `noUncheckedIndexedAccess`. The contract layer rejects
    // unknown kinds at the wire, so an out-of-range kind cannot
    // reach here. Derived up-front so the metric's `to` label is the
    // destination lifecycle status (`in_progress` for `check_in`,
    // `completed` for `check_out`) even on the early input-guard
    // branches — TS-060-followup-4a fans these transitions onto the
    // shared `booking_status_transition_total` / `booking_completion_
    // total` funnels via `recordTransitionOutcome`.
    const transition = CHECK_IN_TRANSITION[input.request.kind]!;
    const to = transition.to;

    if (input.actorUserId.length === 0) {
      this.metrics.recordTransitionOutcome('unknown', to, 'invalid_request');
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }
    if (input.bookingId.length === 0) {
      this.metrics.recordTransitionOutcome('unknown', to, 'invalid_request');
      return err({ reason: 'invalid_request', message: 'bookingId is required' });
    }

    const existing = (await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
    })) as BookingRecord | null;
    if (existing === null) {
      this.metrics.recordTransitionOutcome('unknown', to, 'not_found');
      return err({ reason: 'booking_not_found', bookingId: input.bookingId });
    }

    // ── TS-302e — the trust & safety hold gate ──────────────────────────
    //
    // **The task framed this as one question with two bad answers; there are
    // two events, and they have opposite answers.**
    //
    // `check_in` (confirmed → in_progress) is the visit STARTING. Nothing has
    // happened yet, and letting it start is precisely what the hold exists to
    // prevent. Refuse — the same posture as TS-304's booking-create 409.
    //
    // `check_out` (in_progress → completed) is the visit having HAPPENED.
    // Refusing does not un-happen it. It means the platform holds no record of
    // a visit that occurred: the family loses the visit note, the provider
    // loses their payout evidence, and trust & safety loses the fact that a
    // held visit went ahead anyway — which is itself safety-relevant
    // information, and the piece hardest to reconstruct later. So a held
    // check-out is RECORDED, and loudly.
    //
    // Note what the population actually is: TS-304 already blocks new bookings
    // and suspends pending ones, so a held check-out means a hold landed WHILE
    // the provider was in the household. That is exactly the case where the
    // record matters most and where refusing would help least.
    if (existing.heldByIncidentId !== null) {
      if (transition.to === 'completed') {
        this.metrics.recordHeldCheckIn(input.request.kind, 'allowed');
        this.logger.warn(
          `check_in.completed_under_hold bookingId=${existing.id} incidentId=${existing.heldByIncidentId}`,
        );
        // falls through to the normal path — deliberately
      } else {
        this.metrics.recordHeldCheckIn(input.request.kind, 'refused');
        this.metrics.recordTransitionOutcome(existing.status, to, 'invalid_transition');
        this.logger.warn(
          `check_in.blocked_by_hold bookingId=${existing.id} kind=${input.request.kind} incidentId=${existing.heldByIncidentId}`,
        );
        return err({ reason: 'booking_held', bookingId: existing.id, kind: input.request.kind });
      }
    }

    if (existing.status !== transition.from) {
      this.metrics.recordTransitionOutcome(existing.status, to, 'invalid_transition');
      return err({
        reason: 'invalid_lifecycle_state',
        bookingStatus: existing.status,
        requiredStatus: transition.from,
        kind: input.request.kind,
      });
    }

    // Defence-in-depth: validate the transition through the lifecycle
    // service so the matrix that bounds legal transitions stays in
    // one place. If the status gate above already passed, this is a
    // no-op — but a malformed CHECK_IN_TRANSITION constant would be
    // caught here before any DB write.
    const validation = this.lifecycle.validateTransition(existing.status, transition.to);
    if (!validation.ok) {
      // Should be unreachable given the explicit `from` check above.
      // Log + surface as `invalid_lifecycle_state` so the controller
      // path stays uniform.
      this.logger.warn(
        `check_in.lifecycle_mismatch bookingId=${existing.id} from=${existing.status} to=${transition.to}`,
      );
      this.metrics.recordTransitionOutcome(existing.status, to, 'invalid_transition');
      return err({
        reason: 'invalid_lifecycle_state',
        bookingStatus: existing.status,
        requiredStatus: transition.from,
        kind: input.request.kind,
      });
    }

    const now = new Date();
    const id = `chk_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const latitudeStr = roundToDecimalString(input.request.latitude, 6);
    const longitudeStr = roundToDecimalString(input.request.longitude, 6);
    const accuracyStr =
      input.request.locationAccuracyMeters !== undefined
        ? roundToDecimalString(input.request.locationAccuracyMeters, 2)
        : null;

    try {
      const result = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const checkInRow = (await tx.bookingCheckIn.create({
          data: {
            id,
            bookingId: existing.id,
            kind: input.request.kind,
            latitude: latitudeStr,
            longitude: longitudeStr,
            ...(accuracyStr !== null && { locationAccuracyMeters: accuracyStr }),
            occurredAt: now,
            recordedByUserId: input.actorUserId,
          },
        })) as CheckInRecord;

        const updatedBooking = (await tx.booking.update({
          where: { id: existing.id },
          data: {
            status: transition.to,
            ...(transition.to === 'completed' && { completedAt: now }),
          },
        })) as BookingRecord;

        const eventName = transitionEventName(transition.to);
        const payload = buildTransitionEventPayload({
          eventName,
          row: updatedBooking,
          now,
        });
        const appendResult = await this.outbox.append(
          tx as unknown as OutboxRawExecutor,
          // The `eventName`-driven payload typing is a discriminated
          // union at the registry layer; the SDK validates the runtime
          // shape against `getEventSchema(eventName)`.
          { eventName, payload } as never,
        );
        if (appendResult.kind !== 'appended') {
          throw new OutboxValidationFailedError(appendResult.eventName, appendResult.issues);
        }

        return { checkIn: checkInRow, booking: updatedBooking };
      });

      // A successful `check_out` (`to === 'completed'`) also lands on the
      // completion sub-funnel — `recordTransitionOutcome` fans it
      // automatically (TS-060-followup-4a), so the geo check-out path is now
      // counted alongside the generic `BookingsService.transitionStatus`
      // completion.
      this.metrics.recordTransitionOutcome(existing.status, to, 'applied');
      this.logger.log(
        `check_in.recorded bookingId=${result.booking.id} kind=${input.request.kind} ${existing.status} -> ${result.booking.status}`,
      );
      return ok(result);
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.metrics.recordTransitionOutcome(existing.status, to, 'outbox_validation_failed');
        this.logger.error(`check_in outbox validation failed: ${e.message}`);
        return err({
          reason: 'outbox_validation_failed',
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      if (isPrismaUniqueViolation(e)) {
        // Concurrent double-POST against the UNIQUE (booking_id, kind)
        // index. The first caller wins; the second sees `already_recorded`.
        this.metrics.recordTransitionOutcome(existing.status, to, 'already_recorded');
        return err({
          reason: 'already_recorded',
          bookingId: input.bookingId,
          kind: input.request.kind,
        });
      }
      throw e;
    }
  }

  async listByBookingId(
    input: ListCheckInsInput,
  ): Promise<Result<readonly CheckInRecord[], CheckInsServiceFailure>> {
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

    const rows = (await this.prisma.bookingCheckIn.findMany({
      where: { bookingId: booking.id },
      orderBy: { occurredAt: 'asc' },
    })) as unknown as readonly CheckInRecord[];

    this.logger.debug(
      `check_in.list bookingId=${booking.id} actorUserId=${input.actorUserId} count=${rows.length}`,
    );
    return ok(rows);
  }
}

function transitionEventName(status: BookingStatus): EventName {
  switch (status) {
    case 'in_progress':
      return BOOKING_IN_PROGRESS;
    case 'completed':
      return BOOKING_COMPLETED;
    case 'pending':
    case 'confirmed':
    case 'canceled':
    case 'declined':
      throw new Error(`transitionEventName: unexpected status ${status} for check-in flow`);
  }
}

/**
 * Round a JSON-supplied number to `decimals` places and return the
 * canonical fixed-point string the Decimal column expects. Uses
 * integer math to dodge float-precision artefacts — multiply by
 * 10^decimals, round-half-up to nearest integer, divide back.
 *
 * Example: roundToDecimalString(40.71281234, 6) → "40.712812".
 */
function roundToDecimalString(value: number, decimals: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`roundToDecimalString: non-finite value ${value}`);
  }
  const scale = 10 ** decimals;
  const negative = value < 0;
  const scaled = Math.round(Math.abs(value) * scale);
  const integer = Math.floor(scaled / scale);
  const fraction = scaled % scale;
  return `${negative && (integer !== 0 || fraction !== 0) ? '-' : ''}${integer}.${fraction
    .toString()
    .padStart(decimals, '0')}`;
}

/**
 * Duck-typed Prisma P2002 narrowing — same TS-021-followup-2 root
 * cause documented elsewhere. The Prisma 5.22 namespace value-side
 * resolves inconsistently under our tsconfig; using a duck-typed
 * guard keeps the service self-contained until TS-021-followup-2's
 * upgrade lands.
 */
function isPrismaUniqueViolation(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && code === 'P2002';
}

/**
 * Surface an outbox validation failure as a typed exception so the
 * Prisma `$transaction` rolls back — the check-in row + booking
 * update + outbox event invariant holds (PDD §7.3).
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
