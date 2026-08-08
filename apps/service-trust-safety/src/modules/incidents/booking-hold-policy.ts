import type { IncidentSeverity } from './incident-enums';

/**
 * The booking-hold predicate (TS-304; PRD §10.14; PDD §16.1; CLAUDE.md §12).
 *
 * **This is trust & safety's decision to own, and it lives on this side of
 * the wire deliberately.** `service-booking` receives an explicit
 * `trust_safety.booking_hold.requested` and applies it; it never inspects a
 * severity to decide whether visits stop. Two copies of "which concerns are
 * serious enough to suspend a family's care" is how they drift, and the copy
 * that would drift is the one in the service with no trust & safety context.
 *
 * **Why `high` and `critical`.** These are the two grades whose SLA budgets
 * (TS-300 `sla.ts`: 8h and 2h) are short enough that a hold is measured in
 * hours, not weeks. `medium` (24h) and `low` (72h) carry the everyday
 * billing and conduct reports; suspending a senior's meals and companionship
 * over one of those does its own harm — CLAUDE.md §12's hospitality framing
 * cuts both ways, and an over-broad hold is a care interruption, not a
 * safety measure.
 *
 * Note the interaction with TS-302's re-grading: severity is computed at
 * intake and a triage pass may raise it. A re-grade from `medium` to `high`
 * does NOT retroactively emit a hold today — the hold rides the open and
 * resolve transitions only. That gap is real and filed (see the TS-304
 * completion entry) rather than papered over with a booking-side severity
 * check.
 */
export const BOOKING_HOLD_SEVERITIES: readonly IncidentSeverity[] = ['high', 'critical'] as const;

/** The subject triple a hold applies to. Each is independently nullable. */
export interface BookingHoldSubjects {
  readonly providerId: string | null;
  readonly seniorId: string | null;
  readonly householdId: string | null;
}

/**
 * True when this incident should suspend bookings.
 *
 * BOTH conditions are required, and the second is not a formality: an
 * incident may legitimately name no provider, senior, or household (a
 * `system`-ingested flag, or a billing report filed before the household is
 * resolved). A hold naming no subject is not a narrow suspension — it is a
 * platform-wide freeze, so it must never be emitted. The contract refuses
 * that payload too (`TrustSafetyBookingHoldRequestedSchema`); this predicate
 * stops it one layer earlier, where the answer is "no hold applies" rather
 * than "the append failed".
 */
export function isBookingHoldEligible(
  incident: { readonly severity: IncidentSeverity } & BookingHoldSubjects,
): boolean {
  if (!BOOKING_HOLD_SEVERITIES.includes(incident.severity)) return false;
  return hasHoldSubject(incident);
}

/** True when at least one of the three subject references is present. */
export function hasHoldSubject(subjects: BookingHoldSubjects): boolean {
  return (
    subjects.providerId !== null || subjects.seniorId !== null || subjects.householdId !== null
  );
}
