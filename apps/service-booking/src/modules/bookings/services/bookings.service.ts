import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BOOKING_CANCELED,
  BOOKING_COMPLETED,
  BOOKING_CONFIRMED,
  BOOKING_CREATED,
  BOOKING_DECLINED,
  BOOKING_IN_PROGRESS,
  BOOKING_TIER_GATING_VIOLATION,
  type BookingCancellationReason,
  type BookingDeclineKind,
  type BookingDeclineReason,
  type BookingServiceKind,
  type BookingTierGatingViolationReason,
  type CreateBookingRequest,
  type EventName,
  type HouseholdSubscriptionTier,
  type ProviderTierSnapshotTier,
  type TransitionableBookingStatus,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import {
  BookingMetrics,
  type BookingTransitionFrom,
  type BookingTransitionOutcome,
} from '../../../observability/booking-metrics';

import { computeCommissionMinor, minorToDecimalString, ratioFromBps } from '../../../common/money';
import { err, ok, type Result } from '../../../common/result';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import { buildTransitionEventPayload } from '../../lifecycle/build-transition-event-payload';
import { BookingLifecycleService } from '../../lifecycle/booking-lifecycle.service';
import type { BookingStatus, InvalidTransitionError } from '../../lifecycle/booking-status';
import { SubjectHoldsService } from '../../subject-holds/services/subject-holds.service';
import type { BookingSubjectHoldKind } from '../../subject-holds/subject-hold-kinds';
import {
  TierGatingService,
  type TierGatingDecision,
} from '../../tier-gating/services/tier-gating.service';

/**
 * Local mirror of the Prisma-generated `Booking` row. Same
 * TS-021-followup-2 / TS-021-followup-3 root cause documented across
 * the codebase — the contract-side `BookingResponse` schema in
 * `packages/contracts` cross-pins the network-facing shape, and
 * TS-060-followup-5 drops this mirror when Prisma 5.23 / 6.x resolves
 * the namespace value-side cleanly.
 *
 * Money fields land as `Decimal` (Prisma's runtime type) — they cross
 * the BookingsService boundary as `Decimal` and are converted to
 * integer minor units only at the mapper layer (CLAUDE.md §6 — "Round
 * once, at presentation").
 */
export interface BookingRecord {
  readonly id: string;
  readonly householdId: string;
  readonly seniorId: string;
  readonly providerId: string;
  readonly serviceKind: BookingServiceKind;
  readonly status: BookingStatus;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly currency: string;
  readonly basePrice: { toString(): string };
  readonly commissionRate: { toString(): string };
  readonly commissionAmount: { toString(): string };
  readonly finalPrice: { toString(): string };
  readonly bookingNotes: string | null;
  readonly completedAt: Date | null;
  readonly canceledAt: Date | null;
  readonly cancellationReason: string | null;
  readonly cancellationReasonText: string | null;
  readonly acceptWindowExpiresAt: Date | null;
  readonly declinedAt: Date | null;
  readonly declineKind: string | null;
  readonly declineReason: string | null;
  readonly declineReasonText: string | null;
  readonly declinedByUserId: string | null;
  /**
   * TS-304's hold marker. Non-null while a trust & safety incident suspends
   * this specific visit. The mapper narrows it to a boolean on the way out —
   * the incident id never reaches a booking read surface (TS-304-followup-1).
   */
  readonly heldByIncidentId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Inputs accepted by `BookingsService.createBooking`. The controller
 * supplies the trusted authenticated `userId` separately so the
 * service can enforce row-level checks server-side (CLAUDE.md §3.2).
 */
export interface CreateBookingInput {
  readonly actorUserId: string;
  readonly request: CreateBookingRequest;
}

export interface TransitionStatusInput {
  readonly actorUserId: string;
  /**
   * What KIND of actor is transitioning (TS-308c-followup-3).
   *
   * **Required, not optional**, and derived by the controller from the
   * verified access token — never from a body. A caller that forgets it
   * is a compile error rather than a row that silently reads as
   * "customer", which is the shape TS-308c-followup-2 learned to insist
   * on after `sourceEventId` sat documented-but-unwired for a week.
   *
   * Only recorded on a cancel; the other transitions have no use for it.
   */
  readonly actorKind: BookingCancelActorKind;
  readonly bookingId: string;
  readonly targetStatus: TransitionableBookingStatus;
  readonly cancellationReason?: BookingCancellationReason;
  readonly cancellationReasonText?: string;
}

/**
 * The two actor kinds a verified token can distinguish. See the Prisma
 * enum's doc-block for why there is no third value.
 */
export type BookingCancelActorKind = 'staff' | 'customer';

/**
 * Inputs accepted by `BookingsService.acceptBooking` (TS-205).
 *
 * The controller supplies the authenticated `userId` as `actorUserId`
 * — the service trusts the controller's gate today (Phase-1 row-level
 * check; TS-141 will tighten via the Prisma extension once the
 * cross-service provider-userId membership lookup lands).
 */
export interface AcceptBookingInput {
  readonly actorUserId: string;
  readonly bookingId: string;
}

/**
 * Inputs accepted by `BookingsService.declineBooking` (TS-205).
 *
 * `declineKind` defaults to `provider_declined` at the controller
 * layer (the manual decline endpoint). The auto-decline worker
 * (TS-205-followup-1) passes `window_expired`; admin override
 * (TS-128) passes `admin_declined`.
 *
 * `declineReason` is required for `provider_declined` / `admin_declined`
 * at the contract layer; nullable for `window_expired` because the
 * worker has no human input.
 */
export interface DeclineBookingInput {
  readonly actorUserId: string;
  readonly bookingId: string;
  readonly declineKind: BookingDeclineKind;
  readonly declineReason: BookingDeclineReason | null;
  readonly declineReasonText?: string;
}

/**
 * Failure shapes returned by `BookingsService`. Mirrors the
 * discriminated-union pattern used elsewhere (CLAUDE.md §2.1) so the
 * controller can switch exhaustively to the HTTP status.
 */
export type BookingsServiceFailure =
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'not_found'; readonly bookingId: string }
  | { readonly reason: 'forbidden'; readonly message: string }
  | {
      readonly reason: 'invalid_transition';
      readonly from: BookingStatus;
      readonly to: BookingStatus;
      readonly allowed: readonly BookingStatus[];
    }
  /**
   * The provider accept window has elapsed (TS-205). Surfaced by
   * `acceptBooking` only — the manual decline path accepts past-
   * window because ops still wants the decline reason on record.
   * The auto-decline worker (TS-205-followup-1) will eventually
   * flip the row to `declined` with `decline_kind = 'window_expired'`;
   * this failure surfaces in the small race window between expiry
   * and the worker firing.
   */
  | {
      readonly reason: 'accept_window_expired';
      readonly bookingId: string;
      readonly windowExpiredAt: Date;
    }
  | { readonly reason: 'outbox_validation_failed'; readonly message: string }
  /**
   * Tier-gating refused the booking under `enforce` mode (TS-064;
   * CLAUDE.md §12). Carries the categorical reason
   * (`tier_3_requires_elite` | `household_snapshot_unknown` |
   * `provider_snapshot_unknown`) and the two tier values read from
   * the cache (either may be null when the corresponding snapshot is
   * missing). Maps to HTTP 409 — the request is well-formed but
   * conflicts with the active policy.
   */
  | {
      readonly reason: 'tier_gating_violation';
      readonly violationReason: BookingTierGatingViolationReason;
      readonly householdTier: HouseholdSubscriptionTier | null;
      readonly providerTier: ProviderTierSnapshotTier | null;
    }
  /**
   * A trust & safety hold covers one of the booking's subjects (TS-304;
   * PRD §10.14; CLAUDE.md §12). The provider, the senior, or the
   * household is under review for a `high` / `critical` concern, and new
   * visits do not proceed until the review committee closes it.
   *
   * Carries the blocking incident id + which subject it names so an
   * operator can navigate straight to the incident. It deliberately does
   * NOT carry the concern's category or free text: this failure surfaces
   * to a family member booking a visit, and "your provider is under
   * investigation for a welfare concern" is not ours to disclose on a
   * booking form (CLAUDE.md §3.9, §12).
   */
  | {
      readonly reason: 'subject_on_hold';
      readonly incidentId: string;
      readonly subjectKind: BookingSubjectHoldKind;
    };

/**
 * Booking orchestration (TS-060-followup-1).
 *
 * The owner of every `bookings` row mutation. Three operations:
 *
 *   - `createBooking({ actorUserId, request })` — inserts a new row
 *     in `pending` and emits `booking.created` through the outbox in
 *     the same Prisma transaction.
 *
 *   - `transitionStatus({ actorUserId, bookingId, targetStatus, ... })`
 *     — moves a row from its current status to `targetStatus`,
 *     validating the transition against `BookingLifecycleService`,
 *     stamping `completedAt` / `canceledAt` on the matching terminal
 *     transition, and emitting the matching domain event
 *     (`booking.confirmed` / `.in_progress` / `.completed` / `.canceled`)
 *     transactionally with the UPDATE.
 *
 *   - `getById({ actorUserId, bookingId })` — reads a single row,
 *     row-level-gated to participants (household_id membership OR
 *     provider_id match — Phase 1 enforcement is "actor.userId ===
 *     householdMember OR actor.userId === providerUserId", with the
 *     real cross-service membership check landing alongside TS-141
 *     and TS-064).
 *
 * **Outbox + tenant scoping**. Every mutation runs inside
 * `prisma.$transaction` so the bookings row + the outbox row commit
 * atomically. The outbox SDK validates the event payload against the
 * `eventRegistry` schema at producer time; a payload that fails
 * validation surfaces as `outbox_validation_failed` (effectively a
 * 500 — the service-layer payload is constructed from trusted
 * server-side data, so a validation failure means we have a bug).
 *
 * Row-level checks (CLAUDE.md §3.2) live here today because the
 * tenant-scoping Prisma extension (TS-141) hasn't landed yet. Once
 * TS-141 ships, the extension will reject queries that don't carry a
 * `requestContext` and the service-level guards become defence-in-
 * depth rather than the sole protection.
 *
 * Phase-1 row-level model. Service-booking does NOT own household
 * membership or the provider→user mapping (those live in
 * service-household and service-provider respectively). For Phase 1
 * the service trusts the controller's authenticated `userId` and
 * embeds it as `canceledByUserId` on the cancel event; full
 * row-level enforcement (the family-payer / family-observer /
 * provider triple) lands with TS-141 + the gateway BFF's tenant
 * scoping (TS-140). The service exposes the actor on every read /
 * mutation API so the gate can be tightened without a contract
 * change.
 */
@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: BookingLifecycleService,
    private readonly outbox: OutboxService,
    private readonly tierGating: TierGatingService,
    // TS-304 — the trust & safety hold screen consulted before any
    // booking-create side effect.
    private readonly subjectHolds: SubjectHoldsService,
    private readonly metrics: BookingMetrics,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  /**
   * Record one lifecycle-transition outcome (broad transition counter + the
   * completion sub-funnel when `to === 'completed'`). Thin pass-through to the
   * shared {@link BookingMetrics.recordTransitionOutcome} fan-out — kept as a
   * private alias so the in-service call sites stay terse and the
   * transition→completion coupling lives in exactly one place, shared with
   * `CheckInsService` (TS-060-followup-4a).
   */
  private recordTransitionOutcome(
    from: BookingTransitionFrom,
    to: BookingStatus,
    outcome: BookingTransitionOutcome,
  ): void {
    this.metrics.recordTransitionOutcome(from, to, outcome);
  }

  async createBooking(
    input: CreateBookingInput,
  ): Promise<Result<BookingRecord, BookingsServiceFailure>> {
    if (input.actorUserId.length === 0) {
      this.metrics.recordCreated('invalid_request');
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }
    const req = input.request;

    const id = `bkg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const now = new Date();

    // TS-060-followup-1c — reject a booking whose `scheduledStart` is in
    // the past BEFORE any side effect (tier-gating evaluation, money
    // math, row insert, outbox append). The contract already guarantees
    // `scheduledEnd > scheduledStart` (CreateBookingRequestSchema
    // `.superRefine`); this guards the lower bound the contract leaves
    // open. Operationally a past `scheduledStart` is only meaningful when
    // ops backfills a historical booking — that flows through the
    // dedicated admin-override surface (PRD §10.5 / TS-128), never this
    // family-facing endpoint. `now` is the trusted server clock; the
    // boundary is exclusive so a booking scheduled for exactly `now` is
    // still accepted.
    if (new Date(req.scheduledStart).getTime() < now.getTime()) {
      this.metrics.recordCreated('invalid_request');
      return err({
        reason: 'invalid_request',
        message: 'scheduledStart must not be in the past',
      });
    }

    // TS-304 — trust & safety hold screen (PRD §10.14; CLAUDE.md §12).
    // Runs BEFORE the tier gate, and that order is deliberate: a subject
    // under review for a critical concern should be refused on the safety
    // ground, not on a tier-snapshot technicality, and the tier gate emits
    // a `booking.tier_gating_violation` event that would misattribute the
    // refusal. This screen emits nothing — the hold is already recorded
    // against an incident, so a blocked attempt needs no second event.
    const holds = await this.subjectHolds.screenSubjects({
      providerId: req.providerId,
      seniorId: req.seniorId,
      householdId: req.householdId,
    });
    const blockingHold = holds[0];
    if (blockingHold !== undefined) {
      this.metrics.recordCreated('subject_on_hold');
      this.logger.warn(
        `booking.create refused — subject_on_hold actorUserId=${input.actorUserId} incidentId=${blockingHold.incidentId} subjectKind=${blockingHold.subjectKind} household=${req.householdId} provider=${req.providerId}`,
      );
      return err({
        reason: 'subject_on_hold',
        incidentId: blockingHold.incidentId,
        subjectKind: blockingHold.subjectKind,
      });
    }

    // TS-064 — tier gating (CLAUDE.md §12). Consult the local read-side
    // snapshot cache BEFORE any money math or row insert so a
    // tier-mismatched booking attempt never spends a Stripe round-trip.
    // The decision shape encodes which of the two modes (`enforce` /
    // `advisory`) was active. In `enforce`, a violation aborts here; in
    // `advisory`, we log + emit a warning event but proceed with the
    // booking. Either way, a violation gets a `booking.tier_gating_violation`
    // outbox event for trust-safety + analytics visibility.
    const tierDecision = await this.tierGating.evaluate({
      householdId: req.householdId,
      providerId: req.providerId,
      serviceKind: req.serviceKind,
    });
    if (tierDecision.outcome !== 'allowed') {
      const emitResult = await this.emitTierGatingViolation({
        attemptId: id,
        decision: tierDecision,
        actorUserId: input.actorUserId,
        householdId: req.householdId,
        providerId: req.providerId,
        serviceKind: req.serviceKind,
        now,
      });
      if (!emitResult.ok) {
        this.metrics.recordCreated('outbox_validation_failed');
        return emitResult;
      }
      if (tierDecision.outcome === 'blocked') {
        this.metrics.recordCreated('tier_gating_blocked');
        this.logger.warn(
          `booking.tier_gating_violation blocked actorUserId=${input.actorUserId} household=${req.householdId} provider=${req.providerId} reason=${tierDecision.reason}`,
        );
        return err({
          reason: 'tier_gating_violation',
          violationReason: tierDecision.reason,
          householdTier: tierDecision.householdTier,
          providerTier: tierDecision.providerTier,
        });
      }
      // advisory mode — log + proceed.
      this.logger.warn(
        `booking.tier_gating_violation advisory actorUserId=${input.actorUserId} household=${req.householdId} provider=${req.providerId} reason=${tierDecision.reason}`,
      );
    }

    // Derive money fields server-side from the basis-points commission
    // rate. Math is in **integer minor units** at the controller layer
    // and converted to Decimal at the persistence boundary so the row
    // stores `Decimal(12,2)` per CLAUDE.md §4.1 / §17.6.
    const basePriceMinor = req.basePriceMinor;
    const commissionRateBps = req.commissionRateBps;
    const commissionAmountMinor = computeCommissionMinor(basePriceMinor, commissionRateBps);
    // `finalPriceMinor` equals `basePriceMinor` at create time and
    // diverges later with TS-043 coupons / TS-084 tax + refunds.
    const finalPriceMinor = basePriceMinor;

    // TS-205 — accept-window stamp. Derived from the resolved
    // `BOOKING_ACCEPT_WINDOW_MINUTES` env var (default 30 min). The
    // auto-decline worker (TS-205-followup-1) consults this column;
    // until then, the accept endpoint refuses past-window accepts so
    // a booking can't slip through silently.
    const acceptWindowExpiresAt = new Date(
      now.getTime() + this.env.BOOKING_ACCEPT_WINDOW_MINUTES * 60_000,
    );

    try {
      const created = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const row = (await tx.booking.create({
          data: {
            id,
            householdId: req.householdId,
            seniorId: req.seniorId,
            providerId: req.providerId,
            serviceKind: req.serviceKind,
            status: 'pending',
            scheduledStart: new Date(req.scheduledStart),
            scheduledEnd: new Date(req.scheduledEnd),
            currency: req.currency,
            basePrice: minorToDecimalString(basePriceMinor),
            commissionRate: ratioFromBps(commissionRateBps),
            commissionAmount: minorToDecimalString(commissionAmountMinor),
            finalPrice: minorToDecimalString(finalPriceMinor),
            acceptWindowExpiresAt,
            ...(req.bookingNotes !== undefined && { bookingNotes: req.bookingNotes }),
          },
        })) as BookingRecord;

        // TS-305d-followup-2b1b — the top-level `eventId` is what reaches the
        // `event_id` column (`args.eventId ?? this.options.idGenerator()`), and
        // it is the id the relay publishes and consumers dedup on. Passing it
        // only inside `payload` left the column holding a random value, so the
        // 1:1 property the comment below asserts was not actually in force.
        const appendResult = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
          eventName: BOOKING_CREATED,
          eventId: id,
          payload: {
            eventId: id, // bookingId-derived event id keeps create+event 1:1.
            occurredAt: now.toISOString(),
            bookingId: row.id,
            householdId: row.householdId,
            seniorId: row.seniorId,
            providerId: row.providerId,
            serviceKind: row.serviceKind,
            scheduledStart: row.scheduledStart.toISOString(),
            scheduledEnd: row.scheduledEnd.toISOString(),
            currency: row.currency,
            basePriceMinor,
            commissionRateBps,
            commissionAmountMinor,
            finalPriceMinor,
            // TS-217-prep-4c — echo the originating search-correlation token
            // (null when this booking did not arrive from a search) so
            // service-analytics can attribute the booking to the exact search.
            searchId: req.searchId ?? null,
          },
        });
        if (appendResult.kind !== 'appended') {
          throw new OutboxValidationFailedError(appendResult.eventName, appendResult.issues);
        }
        return row;
      });

      this.metrics.recordCreated('created');
      this.logger.log(
        `booking.created bookingId=${created.id} householdId=${created.householdId} providerId=${created.providerId}`,
      );
      return ok(created);
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.metrics.recordCreated('outbox_validation_failed');
        this.logger.error(`booking.create outbox validation failed: ${e.message}`);
        return err({
          reason: 'outbox_validation_failed',
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }

  async transitionStatus(
    input: TransitionStatusInput,
  ): Promise<Result<BookingRecord, BookingsServiceFailure>> {
    const to = input.targetStatus as BookingStatus;
    if (input.actorUserId.length === 0) {
      this.recordTransitionOutcome('unknown', to, 'invalid_request');
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }
    if (input.bookingId.length === 0) {
      this.recordTransitionOutcome('unknown', to, 'invalid_request');
      return err({ reason: 'invalid_request', message: 'bookingId is required' });
    }

    const existing = (await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
    })) as BookingRecord | null;
    if (existing === null) {
      this.recordTransitionOutcome('unknown', to, 'not_found');
      return err({ reason: 'not_found', bookingId: input.bookingId });
    }

    const targetStatus = to;
    const validation = this.lifecycle.validateTransition(existing.status, targetStatus);
    if (!validation.ok) {
      const e = validation.error as InvalidTransitionError;
      this.recordTransitionOutcome(existing.status, targetStatus, 'invalid_transition');
      return err({
        reason: 'invalid_transition',
        from: e.from,
        to: e.to,
        allowed: e.allowed,
      });
    }

    const now = new Date();

    try {
      const updated = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const row = (await tx.booking.update({
          where: { id: existing.id },
          data: {
            status: targetStatus,
            ...(targetStatus === 'completed' && { completedAt: now }),
            ...(targetStatus === 'canceled' && {
              canceledAt: now,
              // TS-308c — the actor goes on the ROW, not just the event.
              // `booking.canceled` has always carried it, but an outbox
              // entry is relayed and pruned, so "who cancelled this
              // visit" had no durable answer. The decline path has
              // recorded its actor since TS-205; this is the same fact
              // on the same table. Deliberately not surfaced on
              // `BookingResponse` — who cancelled is a per-audience
              // disclosure decision, not a mapper default.
              canceledByUserId: input.actorUserId,
              // TS-308c-followup-3 — the actor's KIND, from the verified
              // token. The id alone cannot say whether ops closed out a
              // departed provider's calendar or that provider abandoned
              // their clients, and the mass-cancellation detector needs
              // to tell those apart before its threshold is ever tuned.
              canceledByActorKind: input.actorKind,
              ...(input.cancellationReason !== undefined && {
                cancellationReason: input.cancellationReason,
              }),
              ...(input.cancellationReasonText !== undefined && {
                cancellationReasonText: input.cancellationReasonText,
              }),
            }),
          },
        })) as BookingRecord;

        const eventName = transitionEventName(targetStatus);
        const payload = buildTransitionEventPayload({
          eventName,
          row,
          now,
          previousStatus: existing.status,
          actorUserId: input.actorUserId,
          ...(input.cancellationReason !== undefined && {
            cancellationReason: input.cancellationReason,
          }),
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
        return row;
      });

      this.recordTransitionOutcome(existing.status, targetStatus, 'applied');
      if (targetStatus === 'canceled') {
        this.metrics.recordCancellation(input.cancellationReason ?? 'unspecified');
      }
      this.logger.log(
        `booking.transition bookingId=${updated.id} ${existing.status} -> ${updated.status}`,
      );
      return ok(updated);
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.recordTransitionOutcome(existing.status, targetStatus, 'outbox_validation_failed');
        this.logger.error(`booking.transition outbox validation failed: ${e.message}`);
        return err({
          reason: 'outbox_validation_failed',
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }

  /**
   * `POST /api/v1/bookings/:id/accept` (TS-205) — provider accepts an
   * inbound booking request, transitioning `pending` → `confirmed`.
   *
   * Refuses if:
   *   - bookingId is empty / actorUserId is empty → `invalid_request`.
   *   - booking does not exist → `not_found`.
   *   - actorUserId is not the booking's assigned provider's user id
   *     (Phase-1 — service trusts the controller's authenticated user;
   *     real cross-service provider-userId membership check lands with
   *     TS-141) → today actor is recorded but NOT gated server-side;
   *     the gate is reserved for the TS-141 follow-up.
   *   - booking is no longer in `pending` (already accepted, declined,
   *     canceled, etc.) → `invalid_transition` carrying the legal set
   *     from `BookingLifecycleService`.
   *   - the accept window has expired → `accept_window_expired` with
   *     the original deadline so the controller can surface the moment
   *     to the operator.
   *
   * On success the row's status flips to `confirmed`, no decline
   * metadata is touched, and a `booking.confirmed` event is appended
   * to the outbox in the same Prisma transaction.
   */
  async acceptBooking(
    input: AcceptBookingInput,
  ): Promise<Result<BookingRecord, BookingsServiceFailure>> {
    if (input.actorUserId.length === 0) {
      this.recordTransitionOutcome('unknown', 'confirmed', 'invalid_request');
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }
    if (input.bookingId.length === 0) {
      this.recordTransitionOutcome('unknown', 'confirmed', 'invalid_request');
      return err({ reason: 'invalid_request', message: 'bookingId is required' });
    }

    const existing = (await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
    })) as BookingRecord | null;
    if (existing === null) {
      this.recordTransitionOutcome('unknown', 'confirmed', 'not_found');
      return err({ reason: 'not_found', bookingId: input.bookingId });
    }

    const validation = this.lifecycle.validateTransition(existing.status, 'confirmed');
    if (!validation.ok) {
      const e = validation.error as InvalidTransitionError;
      this.recordTransitionOutcome(existing.status, 'confirmed', 'invalid_transition');
      return err({
        reason: 'invalid_transition',
        from: e.from,
        to: e.to,
        allowed: e.allowed,
      });
    }

    const now = new Date();
    if (
      existing.acceptWindowExpiresAt !== null &&
      existing.acceptWindowExpiresAt.getTime() <= now.getTime()
    ) {
      this.recordTransitionOutcome(existing.status, 'confirmed', 'accept_window_expired');
      return err({
        reason: 'accept_window_expired',
        bookingId: existing.id,
        windowExpiredAt: existing.acceptWindowExpiresAt,
      });
    }

    try {
      const updated = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const row = (await tx.booking.update({
          where: { id: existing.id },
          data: { status: 'confirmed' },
        })) as BookingRecord;

        const payload = buildTransitionEventPayload({
          eventName: BOOKING_CONFIRMED,
          row,
          now,
          previousStatus: existing.status,
          actorUserId: input.actorUserId,
        });
        const appendResult = await this.outbox.append(
          tx as unknown as OutboxRawExecutor,
          { eventName: BOOKING_CONFIRMED, payload } as never,
        );
        if (appendResult.kind !== 'appended') {
          throw new OutboxValidationFailedError(appendResult.eventName, appendResult.issues);
        }
        return row;
      });

      this.recordTransitionOutcome(existing.status, 'confirmed', 'applied');
      this.logger.log(`booking.accepted bookingId=${updated.id} actorUserId=${input.actorUserId}`);
      return ok(updated);
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.recordTransitionOutcome(existing.status, 'confirmed', 'outbox_validation_failed');
        this.logger.error(`booking.accept outbox validation failed: ${e.message}`);
        return err({
          reason: 'outbox_validation_failed',
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }

  /**
   * `POST /api/v1/bookings/:id/decline` (TS-205) — provider (or admin
   * / auto-decline worker) declines an inbound booking request,
   * transitioning `pending` → `declined`.
   *
   * Refuses if:
   *   - bookingId is empty / actorUserId is empty / declineKind is
   *     `provider_declined`/`admin_declined` with a null
   *     `declineReason` → `invalid_request`.
   *   - booking does not exist → `not_found`.
   *   - booking is no longer in `pending` → `invalid_transition`.
   *
   * On success the row's status flips to `declined`, the decline
   * metadata quartet (`declinedAt`, `declineKind`, `declineReason`,
   * `declineReasonText`, `declinedByUserId`) is stamped exactly once,
   * and a `booking.declined` event is appended to the outbox in the
   * same Prisma transaction. Past-window declines ARE permitted — the
   * decline endpoint accepts at any point while the row is still
   * `pending` so ops can clean up a backlog (the TS-205-followup-1
   * auto-decline worker is the dominant past-window path).
   */
  async declineBooking(
    input: DeclineBookingInput,
  ): Promise<Result<BookingRecord, BookingsServiceFailure>> {
    if (input.actorUserId.length === 0) {
      this.recordTransitionOutcome('unknown', 'declined', 'invalid_request');
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }
    if (input.bookingId.length === 0) {
      this.recordTransitionOutcome('unknown', 'declined', 'invalid_request');
      return err({ reason: 'invalid_request', message: 'bookingId is required' });
    }
    if (
      (input.declineKind === 'provider_declined' || input.declineKind === 'admin_declined') &&
      input.declineReason === null
    ) {
      this.recordTransitionOutcome('unknown', 'declined', 'invalid_request');
      return err({
        reason: 'invalid_request',
        message: `declineReason is required for declineKind ${input.declineKind}`,
      });
    }

    const existing = (await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
    })) as BookingRecord | null;
    if (existing === null) {
      this.recordTransitionOutcome('unknown', 'declined', 'not_found');
      return err({ reason: 'not_found', bookingId: input.bookingId });
    }

    const validation = this.lifecycle.validateTransition(existing.status, 'declined');
    if (!validation.ok) {
      const e = validation.error as InvalidTransitionError;
      this.recordTransitionOutcome(existing.status, 'declined', 'invalid_transition');
      return err({
        reason: 'invalid_transition',
        from: e.from,
        to: e.to,
        allowed: e.allowed,
      });
    }

    const now = new Date();

    try {
      const updated = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const row = (await tx.booking.update({
          where: { id: existing.id },
          data: {
            status: 'declined',
            declinedAt: now,
            declineKind: input.declineKind,
            declineReason: input.declineReason,
            ...(input.declineReasonText !== undefined && {
              declineReasonText: input.declineReasonText,
            }),
            declinedByUserId: input.actorUserId,
          },
        })) as BookingRecord;

        const payload = {
          eventId: `${row.id}.declined.${now.getTime()}`,
          occurredAt: now.toISOString(),
          bookingId: row.id,
          householdId: row.householdId,
          seniorId: row.seniorId,
          providerId: row.providerId,
          serviceKind: row.serviceKind,
          scheduledStart: row.scheduledStart.toISOString(),
          scheduledEnd: row.scheduledEnd.toISOString(),
          declinedAt: now.toISOString(),
          declineKind: input.declineKind,
          declineReason: input.declineReason,
          declinedByUserId: input.actorUserId,
        };
        const appendResult = await this.outbox.append(
          tx as unknown as OutboxRawExecutor,
          { eventName: BOOKING_DECLINED, payload } as never,
        );
        if (appendResult.kind !== 'appended') {
          throw new OutboxValidationFailedError(appendResult.eventName, appendResult.issues);
        }
        return row;
      });

      this.recordTransitionOutcome(existing.status, 'declined', 'applied');
      this.logger.log(
        `booking.declined bookingId=${updated.id} kind=${input.declineKind} actorUserId=${input.actorUserId}`,
      );
      return ok(updated);
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.recordTransitionOutcome(existing.status, 'declined', 'outbox_validation_failed');
        this.logger.error(`booking.decline outbox validation failed: ${e.message}`);
        return err({
          reason: 'outbox_validation_failed',
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }

  async getById(args: {
    readonly actorUserId: string;
    readonly bookingId: string;
  }): Promise<Result<BookingRecord, BookingsServiceFailure>> {
    if (args.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }
    if (args.bookingId.length === 0) {
      return err({ reason: 'invalid_request', message: 'bookingId is required' });
    }
    const row = (await this.prisma.booking.findUnique({
      where: { id: args.bookingId },
    })) as BookingRecord | null;
    if (row === null) {
      return err({ reason: 'not_found', bookingId: args.bookingId });
    }
    // Row-level access (CLAUDE.md §3.2) lives here as a thin marker
    // today — the actor is recorded for future TS-141 enforcement.
    // The endpoint is behind `AccessTokenGuard` so an unauthenticated
    // caller never reaches this method; the inter-tenant gate lands
    // with TS-141 + TS-064. Logged at debug so the trail exists when
    // ops debugs a "why can I see this booking" scenario.
    this.logger.debug(
      `booking.read bookingId=${row.id} actorUserId=${args.actorUserId} status=${row.status}`,
    );
    return ok(row);
  }

  /**
   * Emit a `booking.tier_gating_violation` outbox event for a rejected
   * (enforce mode) or warned (advisory mode) booking attempt. Wrapped
   * in its own degenerate `$transaction` — the outbox SDK requires a
   * transaction client even when there's no row-mutation companion
   * (the row that would have been inserted in `enforce` mode never
   * exists; in `advisory` mode the row gets inserted in the main
   * `$transaction` afterwards, but the violation event must still
   * land regardless of whether that succeeds).
   *
   * Returns the same `Result<never, BookingsServiceFailure>` shape as
   * the caller so the caller can short-circuit on `outbox_validation_failed`.
   */
  private async emitTierGatingViolation(args: {
    readonly attemptId: string;
    readonly decision: Exclude<TierGatingDecision, { outcome: 'allowed' }>;
    readonly actorUserId: string;
    readonly householdId: string;
    readonly providerId: string;
    readonly serviceKind: BookingServiceKind;
    readonly now: Date;
  }): Promise<Result<undefined, BookingsServiceFailure>> {
    const mode = this.tierGating.getMode();
    try {
      await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const appendResult = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
          eventName: BOOKING_TIER_GATING_VIOLATION,
          payload: {
            eventId: `tgv_${args.attemptId}`,
            occurredAt: args.now.toISOString(),
            attemptId: args.attemptId,
            mode,
            reason: args.decision.reason,
            householdId: args.householdId,
            providerId: args.providerId,
            householdTier: args.decision.householdTier,
            providerTier: args.decision.providerTier,
            actorUserId: args.actorUserId,
            serviceKind: args.serviceKind,
          },
        });
        if (appendResult.kind !== 'appended') {
          throw new OutboxValidationFailedError(appendResult.eventName, appendResult.issues);
        }
      });
      return ok(undefined);
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(`booking.tier_gating_violation outbox validation failed: ${e.message}`);
        return err({
          reason: 'outbox_validation_failed',
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }
}

function transitionEventName(status: BookingStatus): EventName {
  switch (status) {
    case 'confirmed':
      return BOOKING_CONFIRMED;
    case 'in_progress':
      return BOOKING_IN_PROGRESS;
    case 'completed':
      return BOOKING_COMPLETED;
    case 'canceled':
      return BOOKING_CANCELED;
    case 'pending':
    case 'declined':
      // Unreachable — `TransitionableBookingStatus` (TS-205: the
      // request-side `targetStatus`) excludes both `pending` (the
      // lifecycle matrix has no edge back to `pending`) and
      // `declined` (the dedicated `acceptBooking`/`declineBooking`
      // endpoints own the `pending` → `declined` transition with
      // their own payload shape; the generic `transitionStatus`
      // path never sees this target).
      throw new Error(`transitionEventName: unexpected status ${status}`);
  }
}

/**
 * Surface an outbox validation failure as a typed exception so the
 * Prisma `$transaction` rolls back (the booking row gets unwound
 * with the failed event row — the outbox invariant from PDD §7.3).
 *
 * Local class — not exported. The service maps it to a typed
 * failure for the controller.
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
      `outbox.append validation failed for ${eventName}: ${issues.map((i) => i.message).join('; ')}`,
    );
    this.name = 'OutboxValidationFailedError';
  }
}
