/**
 * The three subjects a trust & safety hold can name (TS-304).
 *
 * Mirrors the `booking.booking_subject_hold_kind` Postgres enum. Ordered
 * PROVIDER-first deliberately: it is the order the screening result reports
 * a conflict in, and when a booking is blocked by several holds at once the
 * provider is the most actionable one for an operator ("this provider is
 * under investigation" is a re-match; "this senior is under review" is not).
 */
export const BOOKING_SUBJECT_HOLD_KINDS = ['provider', 'senior', 'household'] as const;

export type BookingSubjectHoldKind = (typeof BOOKING_SUBJECT_HOLD_KINDS)[number];

/** The subject triple a hold event names / a booking is screened against. */
export interface BookingHoldSubjectTriple {
  readonly providerId: string | null;
  readonly seniorId: string | null;
  readonly householdId: string | null;
}

/**
 * Flatten a subject triple into the (kind, id) pairs to match on, dropping
 * the nulls.
 *
 * **An empty result is meaningful and must never be treated as "match
 * everything".** It is the reason both `applySubjectHold` and the screening
 * path check for it explicitly: a subjectless hold order would suspend the
 * platform, and a subjectless screen would either block every booking or
 * pass every booking depending on how the SQL was written. Callers get an
 * empty array and are expected to short-circuit.
 */
export function toSubjectPairs(
  subjects: BookingHoldSubjectTriple,
): ReadonlyArray<{ readonly kind: BookingSubjectHoldKind; readonly id: string }> {
  const pairs: { kind: BookingSubjectHoldKind; id: string }[] = [];
  if (subjects.providerId !== null) pairs.push({ kind: 'provider', id: subjects.providerId });
  if (subjects.seniorId !== null) pairs.push({ kind: 'senior', id: subjects.seniorId });
  if (subjects.householdId !== null) pairs.push({ kind: 'household', id: subjects.householdId });
  return pairs;
}
