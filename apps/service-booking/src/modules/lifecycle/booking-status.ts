/**
 * Booking lifecycle state machine (TS-060) — PRD §6.3 + PDD §9.2.
 *
 * The `BookingStatus` union is mirrored at the Prisma layer
 * (`enum BookingStatus` in `prisma/schema.prisma` mapped to the
 * `booking.booking_status` Postgres enum). The local mirror exists
 * because Prisma 5.22's namespace value-side resolves inconsistently
 * under our `verbatimModuleSyntax: false` / `isolatedModules: true`
 * tsconfig — the same root cause documented in
 * TS-021-followup-2 / TS-021-followup-3 / TS-026-followup-5 /
 * TS-051-followup-9. Captured here as a `BOOKING_STATUSES` const tuple
 * so the union, the iteration order, and the runtime guard all derive
 * from one declaration; revisit when the next Prisma minor bump lands.
 *
 * The transition matrix is the source of truth — `BookingLifecycleService`
 * (see sibling file) reads from it for every `canTransition` /
 * `validateTransition` decision. Tests in
 * `booking-lifecycle.service.test.ts` exhaustively cover every
 * (from × to) pair so a change here is impossible to ship silently.
 *
 * **State machine diagram**:
 *
 * ```
 * pending     ──┬──▶ confirmed     ──┬──▶ in_progress  ──┬──▶ completed   (terminal)
 *               ├──▶ canceled        └──▶ canceled       └──▶ canceled    (terminal)
 *               └──▶ declined       (terminal)
 * ```
 *
 * `declined` (TS-205) is reachable from `pending` only — the provider
 * either accepts (→ `confirmed`) or declines (→ `declined`) within the
 * accept window. Distinct from `canceled` because the lifecycle
 * position differs (decline happens BEFORE any commitment), so the
 * cancellation-policy refund/forfeit gate (TS-084) intentionally does
 * NOT fire on `declined`.
 *
 * The terminal states (`completed`, `canceled`, `declined`) intentionally
 * have no outgoing transitions. A "re-open completed booking" need maps
 * to a dispute (TS-065 / `booking_disputes`), not a state-machine
 * transition, so the audit trail of the original completion is
 * preserved (CLAUDE.md §3.6 — append-only audit discipline).
 *
 * Idempotent same-state "transitions" (e.g. `pending → pending`) are
 * **rejected** by `validateTransition`. The orchestration service
 * (TS-060-followup-1's `BookingsService`) is the layer that decides
 * whether a no-op same-state call is a 200 OK (current state matches
 * desired) or a 409 (caller raced with another writer); the lifecycle
 * service alone reports "this is not a legal transition".
 */

export const BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'in_progress',
  'completed',
  'canceled',
  'declined',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * Type guard — true if `value` is a known `BookingStatus`. Used at
 * service boundaries (controller pipes, event consumers) to reject
 * unknown statuses defensively before they reach the lifecycle service.
 */
export function isBookingStatus(value: unknown): value is BookingStatus {
  return typeof value === 'string' && (BOOKING_STATUSES as readonly string[]).includes(value);
}

/**
 * Declarative transition table. Keys are the source state; the value
 * is the (frozen) tuple of legal destination states.
 *
 * Frozen at module-init to make accidental in-place mutation a
 * runtime error rather than silent corruption — the table is consulted
 * by hot read paths (every state mutation passes through here) and
 * the integrity of the matrix is load-bearing for the audit trail.
 */
export const BOOKING_STATUS_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> =
  Object.freeze({
    pending: Object.freeze([
      'confirmed',
      'canceled',
      'declined',
    ] as const) as readonly BookingStatus[],
    confirmed: Object.freeze(['in_progress', 'canceled'] as const) as readonly BookingStatus[],
    in_progress: Object.freeze(['completed', 'canceled'] as const) as readonly BookingStatus[],
    completed: Object.freeze([] as const) as readonly BookingStatus[],
    canceled: Object.freeze([] as const) as readonly BookingStatus[],
    declined: Object.freeze([] as const) as readonly BookingStatus[],
  });

/**
 * Set of terminal states — derived from the transition table so the
 * two stay in lockstep. A state is terminal iff it has zero outgoing
 * transitions.
 */
export const TERMINAL_BOOKING_STATUSES: ReadonlySet<BookingStatus> = new Set(
  BOOKING_STATUSES.filter((status) => BOOKING_STATUS_TRANSITIONS[status].length === 0),
);

/**
 * Failure shape returned by `BookingLifecycleService.validateTransition`.
 * The error is data — orchestration services translate it into the
 * appropriate HTTP status (typically 409 Conflict for a state-machine
 * mismatch).
 */
export interface InvalidTransitionError {
  readonly kind: 'invalid_transition';
  readonly from: BookingStatus;
  readonly to: BookingStatus;
  /**
   * The set of destinations that *would* have been legal from `from`.
   * Empty array means `from` is terminal.
   */
  readonly allowed: readonly BookingStatus[];
}
