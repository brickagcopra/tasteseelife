import { Injectable } from '@nestjs/common';
import type { BookingCancellationReason } from '@taste-and-see/contracts';
import { type Counter, getMeter } from '@taste-and-see/tracing';

import type { BookingStatus } from '../modules/lifecycle/booking-status';

const METER_NAME = 'service-booking:booking';

/**
 * Outcome label for `booking_created_total` (TS-060-followup-4). Partitions
 * every `BookingsService.createBooking` call:
 *
 *   - `created` — the row was inserted and `booking.created` emitted
 *     transactionally.
 *   - `tier_gating_blocked` — `enforce`-mode tier gating refused the booking
 *     (Tier-3 household ↔ non-Elite provider, or a missing snapshot). The
 *     `advisory`-mode warn-and-proceed path still lands as `created`.
 *   - `invalid_request` — a service-layer input guard rejected the request
 *     before any side effect (empty actor, past `scheduledStart`).
 *   - `outbox_validation_failed` — the outbox SDK rejected the event payload,
 *     unwinding the transaction. A server-side bug, not a client error.
 *   - `subject_on_hold` — a trust & safety hold covers the provider, the
 *     senior, or the household (TS-304). Its own label rather than folding
 *     into `tier_gating_blocked`: this counter is the signal for "how much
 *     care is a hold interrupting", which is a number the trust & safety
 *     review cadence should be judged against. A rising `subject_on_hold`
 *     with a flat incident-resolution rate means holds are outliving their
 *     reviews.
 *
 * All values are fixed string literals — cardinality is bounded, no PII
 * (CLAUDE.md §10).
 */
export type BookingCreatedOutcome =
  | 'created'
  | 'tier_gating_blocked'
  | 'subject_on_hold'
  | 'invalid_request'
  | 'outbox_validation_failed';

/**
 * Outcome label for `booking_status_transition_total` (TS-060-followup-4,
 * TS-060-followup-4a). Shared across the canonical `BookingsService`
 * transition surfaces (`transitionStatus`, `acceptBooking`, `declineBooking`)
 * AND the geo check-in/out surface (`CheckInsService`, TS-063):
 *
 *   - `applied` — the transition committed and its domain event emitted.
 *   - `invalid_transition` — the requested edge is not legal from the row's
 *     current status (the lifecycle matrix rejected it → HTTP 409). For
 *     check-ins this folds in the kind↔status mismatch (`invalid_lifecycle_
 *     state`: e.g. a `check_out` against a still-`confirmed` booking).
 *   - `not_found` — no booking row for the supplied id.
 *   - `accept_window_expired` — `acceptBooking` only: the provider accept
 *     window elapsed before the accept landed.
 *   - `invalid_request` — a service-layer input guard rejected the request
 *     (empty actor / id, or a decline missing its required reason).
 *   - `outbox_validation_failed` — the outbox SDK rejected the event payload.
 *   - `already_recorded` — `CheckInsService` only: a concurrent double-POST
 *     collided on the `(booking_id, kind)` UNIQUE index, so the second caller
 *     could not record its check-in (→ HTTP 409). The generic transition
 *     surfaces have no UNIQUE-collision arm.
 *
 * All values are fixed string literals — cardinality is bounded, no PII.
 */
export type BookingTransitionOutcome =
  | 'applied'
  | 'invalid_transition'
  | 'not_found'
  | 'accept_window_expired'
  | 'invalid_request'
  | 'outbox_validation_failed'
  | 'already_recorded';

/**
 * Outcome label for `booking_completion_total` (TS-060-followup-4). Recorded
 * only when the requested transition target is `completed`, so the
 * completion-funnel dashboard reads independently of the broad transition
 * counter:
 *
 *   - `completed` — the booking reached `completed`.
 *   - the five failure arms mirror {@link BookingTransitionOutcome} (a
 *     completion attempt can be rejected for the same reasons), including
 *     the check-out-only `already_recorded` UNIQUE-collision arm.
 *
 * Completion now flows through TWO surfaces (TS-060-followup-4a closed the
 * earlier gap): `BookingsService.transitionStatus` (the family/ops generic
 * transition to `completed`) AND the geo check-OUT path (`CheckInsService`,
 * TS-063), both of which fan through {@link BookingMetrics.recordTransition
 * Outcome}. The admin-override path (TS-128) is still read-only today (no
 * mutation surface to instrument); when it gains a completion mutation it
 * adopts the same helper. All values are fixed string literals — bounded,
 * no PII.
 */
export type BookingCompletionOutcome =
  | 'completed'
  | 'invalid_transition'
  | 'not_found'
  | 'invalid_request'
  | 'outbox_validation_failed'
  | 'already_recorded';

/**
 * Reason label for `booking_cancellation_total` (TS-060-followup-4). The
 * categorical `BookingCancellationReason` the family/ops supplied, or the
 * sentinel `unspecified` when the cancel carried no reason. Recorded only on
 * a SUCCESSFUL cancel transition (a failed cancel attempt lands on the
 * transition counter, not here). Same check-out/admin-path coverage caveat as
 * {@link BookingCompletionOutcome} (TS-060-followup-4a).
 *
 * `BookingCancellationReason` is a fixed six-value enum — cardinality is
 * bounded, no PII (the free-text `cancellationReasonText` is never a label).
 */
export type BookingCancellationLabel = BookingCancellationReason | 'unspecified';

/**
 * The `from` label of `booking_status_transition_total`. The row's status
 * before the transition, or the sentinel `unknown` for the early input-guard
 * branches that reject before the row is loaded (mirrors the `none` sentinel
 * convention in `WebhookMetrics`).
 */
export type BookingTransitionFrom = BookingStatus | 'unknown';

/**
 * service-booking's domain Prometheus instruments (TS-060-followup-4).
 *
 * Four counters cover the canonical orchestration surface
 * (`BookingsService` — TS-060-followup-1):
 *
 *   - `booking_created_total{outcome}` — every `createBooking` call. A rising
 *     `tier_gating_blocked` rate flags a household/provider tier-mismatch
 *     pattern (or a stale snapshot cache); a rising `outbox_validation_failed`
 *     rate is a contract-drift bug.
 *   - `booking_status_transition_total{from,to,outcome}` — every lifecycle
 *     transition attempt across the generic transition, accept, and decline
 *     surfaces. `from`/`to` are bounded `BookingStatus` literals; a rising
 *     `invalid_transition` rate means a client (or worker) is racing the
 *     state machine.
 *   - `booking_completion_total{outcome}` — the completion sub-funnel, scoped
 *     to `to=completed` attempts.
 *   - `booking_cancellation_total{reason}` — successful cancellations by
 *     categorical reason; `welfare_concern` is the trust-safety leading
 *     indicator (CLAUDE.md §12).
 *
 * Label cardinality is bounded by construction — every label is a fixed
 * string-literal union (or the bounded `BookingStatus` / `BookingCancellation
 * Reason` enums), never derived from request payloads (CLAUDE.md §10 PII
 * discipline; no user/household/provider ids as labels).
 *
 * TS-060-followup-4a extended the domain counters into the sibling mutation
 * paths so the funnels read total volume:
 *
 *   - the geo check-in/out path (`CheckInsService`, TS-063) fans through
 *     {@link recordTransitionOutcome} — a `check_out` lands on the completion
 *     sub-funnel exactly as a generic transition-to-`completed` does;
 *   - the recurring bulk-create path (`RecurrenceService`, TS-061) fans
 *     `booking_created_total{outcome=created}` once per materialised child;
 *   - the concierge-create path (TS-207) is a thin wrapper over
 *     `BookingsService.createBooking`, so it is already counted transitively
 *     (instrumenting it again would double-count) — no extra calls there.
 *
 * The admin-override surface (TS-128) is still read-only (list / detail), so
 * it has no booking mutation to count yet; when it gains a completion /
 * cancellation mutation it adopts the same helper. The recurrence-specific
 * failure taxonomy (`invalid_rrule` vs `empty_series`) and the per-surface
 * read counters land with the dedicated recurrence / check-in observability
 * tasks (TS-061-followup-5 / TS-063-followup-6); this counter intentionally
 * folds both recurrence input failures onto `invalid_request`.
 *
 * Instruments are created via `getMeter`, which returns a usable no-op meter
 * when `initMetrics` was never called — so this class is safe to construct in
 * unit tests without booting the SDK. Mirrors the `WebhookMetrics` domain-
 * instrument shape (TS-041a-followup-4).
 */
@Injectable()
export class BookingMetrics {
  private readonly created: Counter;
  private readonly transition: Counter;
  private readonly completion: Counter;
  private readonly cancellation: Counter;
  private readonly heldCheckIn: Counter;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.created = meter.createCounter('booking_created_total', {
      description: 'Total booking-create attempts, by outcome',
    });
    this.transition = meter.createCounter('booking_status_transition_total', {
      description: 'Total booking lifecycle transition attempts, by from/to status and outcome',
    });
    this.completion = meter.createCounter('booking_completion_total', {
      description: 'Total booking completion attempts (target=completed), by outcome',
    });
    this.cancellation = meter.createCounter('booking_cancellation_total', {
      description: 'Total successful booking cancellations, by reason',
    });
    this.heldCheckIn = meter.createCounter('booking_held_check_in_total', {
      description:
        'Check-in/out attempts against a booking suspended by a trust & safety hold, by kind and decision',
    });
  }

  /** Record one `createBooking` outcome. */
  recordCreated(outcome: BookingCreatedOutcome): void {
    this.created.add(1, { outcome });
  }

  /** Record one lifecycle transition attempt with from/to status + outcome. */
  recordTransition(
    from: BookingTransitionFrom,
    to: BookingStatus,
    outcome: BookingTransitionOutcome,
  ): void {
    this.transition.add(1, { from, to, outcome });
  }

  /**
   * Record one lifecycle-transition outcome on the broad transition counter
   * AND, when the target is `completed`, on the completion sub-funnel counter
   * (TS-060-followup-4 / TS-060-followup-4a).
   *
   * Centralised here so every transition producer keeps the two counters in
   * lockstep: `BookingsService` (the generic transition / accept / decline
   * surfaces) and `CheckInsService` (the geo check-in/out surface) both call
   * this rather than re-deriving the fan-out. `accept_window_expired` only
   * ever arises on the accept path (`to = 'confirmed'`), so it is structurally
   * impossible when `to === 'completed'`; the remaining outcomes map 1:1 onto
   * {@link BookingCompletionOutcome} (the transition's `applied` success is
   * named `completed` on the completion funnel).
   */
  recordTransitionOutcome(
    from: BookingTransitionFrom,
    to: BookingStatus,
    outcome: BookingTransitionOutcome,
  ): void {
    this.recordTransition(from, to, outcome);
    if (to === 'completed' && outcome !== 'accept_window_expired') {
      this.recordCompletion(outcome === 'applied' ? 'completed' : outcome);
    }
  }

  /**
   * Record one check-in / check-out attempt against a HELD booking
   * (TS-302e). Two labels, and both decisions are worth counting:
   *
   *   - `{kind: 'check_in', decision: 'refused'}` — the hold did its job and
   *     a visit that should not start did not start.
   *   - `{kind: 'check_out', decision: 'allowed'}` — a held visit went ahead
   *     anyway and we recorded it. **This is the safety-relevant number**: it
   *     means a hold landed after the provider was already in the household,
   *     and a non-zero rate is something trust & safety should be looking at.
   *
   * Deliberately its own counter rather than an outcome on the transition
   * funnel: an allowed held check-out is an `applied` transition there, so it
   * would be invisible in the very series that counts completions.
   */
  recordHeldCheckIn(kind: string, decision: 'refused' | 'allowed'): void {
    this.heldCheckIn.add(1, { kind, decision });
  }

  /**
   * Record one completion attempt (the caller invokes this only when the
   * requested transition target is `completed`).
   */
  recordCompletion(outcome: BookingCompletionOutcome): void {
    this.completion.add(1, { outcome });
  }

  /** Record one successful cancellation, by categorical reason. */
  recordCancellation(reason: BookingCancellationLabel): void {
    this.cancellation.add(1, { reason });
  }
}
