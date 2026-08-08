import { Injectable } from '@nestjs/common';

import { err, ok, type Result } from '../../common/result';
import {
  BOOKING_STATUS_TRANSITIONS,
  type BookingStatus,
  type InvalidTransitionError,
  TERMINAL_BOOKING_STATUSES,
} from './booking-status';

/**
 * Booking lifecycle state machine service (TS-060).
 *
 * Pure logic over `BOOKING_STATUS_TRANSITIONS` — no Prisma, no Redis,
 * no event bus, no I/O of any kind. The orchestration layer that
 * actually mutates a `bookings` row (TS-060-followup-1's
 * `BookingsService`) calls `validateTransition` inside its transaction
 * before issuing the UPDATE, then publishes the matching domain event
 * via the outbox (TS-142).
 *
 * Keeping this layer pure means:
 *
 *   - The transition matrix is independently unit-testable without any
 *     DI scaffolding or fakes.
 *   - The same service is consumable from a Nest controller, a BullMQ
 *     worker, or a Cassandra event-handler — any context that needs to
 *     decide "is this transition legal" without binding to the
 *     orchestration of the actual row mutation.
 *   - The state machine can evolve (additional statuses, new transition
 *     edges) without touching downstream callers' types — they all
 *     consume `BookingStatus` and the `InvalidTransitionError` shape
 *     and the change is mechanical.
 *
 * Decorated `@Injectable()` for DI consumability; nothing in this
 * class requires Nest to be present, so the unit suite constructs it
 * directly without `Test.createTestingModule`.
 */
@Injectable()
export class BookingLifecycleService {
  /**
   * `true` if a transition from `from` → `to` is legal per the
   * declarative table. Same-state "transitions" (`from === to`) are
   * **not** legal here — they represent either an idempotent no-op
   * (caller decision) or a race (orchestration concern), neither of
   * which is the lifecycle service's responsibility to surface.
   */
  canTransition(from: BookingStatus, to: BookingStatus): boolean {
    if (from === to) {
      return false;
    }
    return BOOKING_STATUS_TRANSITIONS[from].includes(to);
  }

  /**
   * `Result`-shaped variant of `canTransition`. Returns `ok` on a
   * legal transition; returns `err(InvalidTransitionError)` carrying
   * the source/destination + the set of legal destinations from
   * `from` so the caller can surface a useful error message.
   *
   * Use this in service-layer orchestration where the decision feeds
   * directly into a Result-returning operation (CLAUDE.md §2.1).
   */
  validateTransition(from: BookingStatus, to: BookingStatus): Result<void, InvalidTransitionError> {
    if (this.canTransition(from, to)) {
      return ok(undefined);
    }
    return err({
      kind: 'invalid_transition',
      from,
      to,
      allowed: BOOKING_STATUS_TRANSITIONS[from],
    });
  }

  /**
   * `true` if `status` is a terminal state (no outgoing transitions).
   * Drives "should we surface a 'cancel' button on this row?" UI
   * decisions and the orchestration service's "is this booking
   * mutable?" gate.
   */
  isTerminal(status: BookingStatus): boolean {
    return TERMINAL_BOOKING_STATUSES.has(status);
  }

  /**
   * Returns the set of legal destination states reachable from
   * `from`. Useful for affordance discovery — the family-portal UI
   * (TS-121) can ask the booking service "what can this booking
   * transition to next?" without re-implementing the matrix
   * client-side.
   */
  allowedTransitions(from: BookingStatus): readonly BookingStatus[] {
    return BOOKING_STATUS_TRANSITIONS[from];
  }
}
