/**
 * The mass-cancellation predicate (TS-308c; PRD §10.13, PDD §17.3;
 * CLAUDE.md §12).
 *
 * Pure functions, no I/O, no Prisma — the whole judgement of what counts
 * as "mass" lives here so it can be argued with in a test rather than
 * inferred from a query.
 */

import type { BookingAnomalySubjectKind } from '@taste-and-see/contracts';

/**
 * How far back each evaluation looks, in hours.
 *
 * A day is the unit the behaviour actually happens in — "a provider
 * cancelled their whole Tuesday", "a household cancelled everything on
 * the morning of the funeral". A shorter window would split one sitting
 * across two evaluations and never breach; a longer one would blur an
 * acute event into a fortnight of ordinary attrition.
 *
 * Overridable per-environment via `BOOKING_MASS_CANCELLATION_WINDOW_HOURS`.
 */
export const DEFAULT_MASS_CANCELLATION_WINDOW_HOURS = 24;

/**
 * Distinct cancellation decisions against ONE PROVIDER, inside the
 * window, before a finding is emitted.
 *
 * **This number is unconfirmed, and saying so is part of shipping it.**
 * Nobody has set a threshold for this platform and there is no
 * cancellation history to fit one against, so what follows is reasoning,
 * not measurement — the same posture as TS-300's SLA budgets and
 * TS-308a's speed ceiling.
 *
 *   - A provider works on the order of three to six visits a day.
 *   - One or two cancellations in a day is ordinary life: a provider
 *     gets sick, a car breaks down, a family reschedules.
 *   - **Five distinct decisions is a provider's whole day of committed
 *     care disappearing.** Several families discover on the same day
 *     that nobody is coming. Whatever caused it — the provider walking
 *     off, an ops bulk action, a run of family cancellations that says
 *     something about this provider — a human should see it.
 *
 * Set too low, this fires on a provider having a bad week, operators
 * learn to dismiss it, and the detector is worse than nothing.
 *
 * Overridable via `BOOKING_MASS_CANCELLATION_PROVIDER_THRESHOLD`.
 */
export const DEFAULT_PROVIDER_CANCELLATION_THRESHOLD = 5;

/**
 * Distinct cancellation decisions by ONE HOUSEHOLD, inside the window,
 * before a finding is emitted. Also unconfirmed; also reasoning.
 *
 * **The dominant benign explanation is a sad one, and the threshold is
 * set around it.** A family whose senior has gone into hospital cancels
 * everything that was booked, and that is a customer in crisis, not an
 * abuser. Two things keep the detector off them:
 *
 *   - a cancelled recurring series counts ONCE (see
 *     `distinctCancellationCount` below), so the common shape of that
 *     event — "cancel the standing Tuesday visit" — is a single
 *     decision, not twelve;
 *   - the threshold is **six**, deliberately higher than the provider's
 *     five even though a household books fewer visits, because a
 *     household reaching six SEPARATE non-series cancellations in a day
 *     has done something a grieving family's afternoon does not
 *     normally reach.
 *
 * It still cannot distinguish the two, and the grade reflects that: a
 * household finding opens at `low`, categorised as a billing-policy
 * concern rather than a welfare one, and carries no description — so
 * nothing in the incident asserts wrongdoing before a human has looked.
 *
 * Overridable via `BOOKING_MASS_CANCELLATION_HOUSEHOLD_THRESHOLD`.
 */
export const DEFAULT_HOUSEHOLD_CANCELLATION_THRESHOLD = 6;

/** A cancelled booking reduced to what the predicate needs. */
export interface CanceledBookingRow {
  readonly bookingId: string;
  readonly providerId: string;
  readonly householdId: string;
  /**
   * Non-null when this booking is one occurrence of a recurring series.
   * Every occurrence in the series carries the same value, which is what
   * lets a series cancellation collapse to one decision.
   */
  readonly seriesId: string | null;
  /**
   * The authenticated user who cancelled, or null for any booking
   * cancelled before TS-308c added the column. Null means UNKNOWN, never
   * "system".
   */
  readonly canceledByUserId: string | null;
  /**
   * What KIND of actor cancelled (TS-308c-followup-3), stamped at the
   * request boundary from the verified token.
   *
   * `'staff'` rows are EXCLUDED from every count. Null means UNKNOWN —
   * every row cancelled before the column landed — and an unknown row
   * still counts, which errs toward opening an incident rather than
   * toward missing one.
   */
  readonly canceledByActorKind: 'staff' | 'customer' | null;
}

/** Per-subject thresholds in force for one evaluation. */
export interface MassCancellationThresholds {
  readonly provider: number;
  readonly household: number;
}

/** One subject that breached, with the numbers it breached on. */
export interface MassCancellationFinding {
  readonly subjectKind: BookingAnomalySubjectKind;
  readonly subjectId: string;
  /** Raw cancelled visits attributed to this subject in the window. */
  readonly canceledBookingCount: number;
  /** Those collapsed per recurring series — the thresholded number. */
  readonly distinctCancellationCount: number;
  readonly threshold: number;
  /** Distinct non-null actors among the raw rows. */
  readonly distinctActorCount: number;
  /** Raw rows with no recorded actor. */
  readonly unattributedCount: number;
  /**
   * Rows cancelled by platform staff, excluded from every count above
   * (TS-308c-followup-3). Reported rather than dropped: "four
   * cancellations, and eight more by us" and "four cancellations" are
   * different situations.
   */
  readonly staffExcludedCount: number;
}

/**
 * Group the window's cancellations by both subjects and return every
 * subject over its threshold.
 *
 * **Both groupings run over the same rows, independently.** One
 * cancellation is simultaneously "a cancellation on provider P" and "a
 * cancellation by household H"; the two questions have different
 * thresholds and different responses, so a row that contributes to a
 * provider finding may also contribute to a household one. That is not
 * double-reporting — it is two different subjects, which is exactly the
 * distinction TS-308c was written around.
 *
 * **The subject is who the cancellations are ABOUT, not who pressed the
 * button.** service-booking cannot map a user id to "the provider" or
 * "a member of this household" — those lookups live in service-provider
 * and service-household, and CLAUDE.md §2.3 forbids reaching across.
 * `distinctActorCount` is the triage colour that stands in for the role
 * lookup: many cancellations by ONE actor and many by MANY actors are
 * different stories, and a reviewer can see which without the join.
 *
 * **Staff-initiated cancellations are excluded entirely**
 * (TS-308c-followup-3). That is the one role distinction the verified
 * token CAN make, and it closes this detector's only known
 * false-positive mode: when a provider leaves the platform, ops cancels
 * their remaining bookings, and before this a departed provider got a
 * `conduct` incident for it. A subject whose every cancellation was ours
 * now yields no finding at all — the threshold comparison sees zero.
 *
 * Findings come back in a stable order — provider subjects then
 * household subjects, each by subject id — so a re-run over the same
 * rows emits in the same sequence. A detector whose output order varies
 * run to run is one nobody trusts.
 */
export function findMassCancellations(
  rows: readonly CanceledBookingRow[],
  thresholds: MassCancellationThresholds,
): readonly MassCancellationFinding[] {
  return [
    ...breachesFor('provider', rows, (row) => row.providerId, thresholds.provider),
    ...breachesFor('household', rows, (row) => row.householdId, thresholds.household),
  ];
}

function breachesFor(
  subjectKind: BookingAnomalySubjectKind,
  rows: readonly CanceledBookingRow[],
  subjectOf: (row: CanceledBookingRow) => string,
  threshold: number,
): readonly MassCancellationFinding[] {
  const bySubject = new Map<string, CanceledBookingRow[]>();
  for (const row of rows) {
    const subjectId = subjectOf(row);
    if (subjectId.length === 0) continue;
    const bucket = bySubject.get(subjectId);
    if (bucket === undefined) bySubject.set(subjectId, [row]);
    else bucket.push(row);
  }

  const findings: MassCancellationFinding[] = [];
  for (const subjectId of [...bySubject.keys()].sort((a, b) => a.localeCompare(b))) {
    const subjectRows = bySubject.get(subjectId);
    if (subjectRows === undefined) continue;

    const counts = countCancellations(subjectRows);
    if (counts.distinctCancellationCount < threshold) continue;

    findings.push({ subjectKind, subjectId, threshold, ...counts });
  }
  return findings;
}

/**
 * Collapse one subject's rows into the numbers a finding carries.
 *
 * **A cancelled recurring series counts ONCE.** Cancelling a standing
 * Tuesday visit is one decision by one person; the platform materialises
 * it as one booking row per occurrence (TS-061), so counting rows would
 * turn a single, entirely ordinary action into a twelve-fold breach —
 * and the family most likely to take that action is the one whose senior
 * has just been hospitalised. The raw count is still reported alongside,
 * because the SIZE of what happened is real even when the number of
 * decisions is one.
 *
 * Occurrences of DIFFERENT series count separately: two series cancelled
 * is two decisions.
 */
function countCancellations(rows: readonly CanceledBookingRow[]): {
  readonly canceledBookingCount: number;
  readonly distinctCancellationCount: number;
  readonly distinctActorCount: number;
  readonly unattributedCount: number;
  readonly staffExcludedCount: number;
} {
  const decisions = new Set<string>();
  const actors = new Set<string>();
  let unattributedCount = 0;
  let staffExcludedCount = 0;

  for (const row of rows) {
    // TS-308c-followup-3 — a staff-initiated cancellation is excluded
    // from every count, including the raw one. When a provider leaves,
    // ops cancels their remaining bookings: one admin acting once, which
    // must not read as that provider abandoning their clients. Note the
    // test is `=== 'staff'`, not `!== 'customer'`: null means the row
    // predates the column, and an unknown row still counts — erring
    // toward opening an incident rather than toward missing one.
    if (row.canceledByActorKind === 'staff') {
      staffExcludedCount += 1;
      continue;
    }
    // A series id and a booking id can never collide (both are cuids
    // from different tables), but the prefix makes the intent legible
    // and survives a future id-scheme change.
    decisions.add(row.seriesId !== null ? `series:${row.seriesId}` : `booking:${row.bookingId}`);
    if (row.canceledByUserId !== null && row.canceledByUserId.length > 0) {
      actors.add(row.canceledByUserId);
    } else {
      unattributedCount += 1;
    }
  }

  return {
    canceledBookingCount: rows.length - staffExcludedCount,
    distinctCancellationCount: decisions.size,
    distinctActorCount: actors.size,
    unattributedCount,
    staffExcludedCount,
  };
}

/**
 * The UTC calendar date a breach is attributed to, `YYYY-MM-DD`.
 *
 * Half of the deterministic event id, and therefore the thing that makes
 * a rolling window safe to re-evaluate: the sweep runs every fifteen
 * minutes over a twenty-four hour window, so without a bucket a subject
 * that breached once would re-emit ninety-six times a day. With it, one
 * subject produces at most ONE event per calendar day, and behaviour
 * that continues into tomorrow opens a fresh incident tomorrow — which
 * is the right signal, because it has not stopped.
 *
 * **UTC, deliberately.** The detector has one clock. Bucketing by a
 * tenant's local day would require a timezone this service does not
 * hold, and would make the dedup key depend on data that can change.
 */
export function utcDateBucket(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * Deterministic event id for a subject's breach on a given day.
 *
 * Same mechanism as TS-308a: the outbox insert is `ON CONFLICT
 * (event_id) DO NOTHING`, so a re-derived id is a no-op rather than a
 * second incident and a second SLA clock. Greppable in the outbox, the
 * relay log and the incident row, which a hash would not be.
 */
export function massCancellationEventId(
  subjectKind: BookingAnomalySubjectKind,
  subjectId: string,
  windowBucket: string,
): string {
  return `mass-cancellation:${subjectKind}:${subjectId}:${windowBucket}`;
}
