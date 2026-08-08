import {
  PROVIDER_METRICS_MIN_SAMPLE,
  PROVIDER_METRICS_WINDOW_DAYS,
} from '@taste-and-see/contracts';
import type {
  ProviderMetricsCounts,
  ProviderMetricsSection,
  ProviderMetricsWindow,
} from '@taste-and-see/contracts';

/**
 * The arithmetic half of the provider metrics read (TS-305d).
 *
 * Pure functions over already-counted facts. Every judgement a reader
 * could be misled by is made here — whether there is enough history to
 * state a rate at all, what each rate's denominator is, and which
 * bookings are eligible for a response-time median — so each one is
 * covered by an ordinary unit test rather than living inside SQL that
 * cannot run without Docker.
 */

/**
 * One booking's contribution to the counts, as read from the fact row.
 * A deliberately narrow shape: the aggregation only ever needs these
 * six columns, and taking the whole row would let a future column
 * silently start influencing a rate. Note `bookingId` and `providerId`
 * are absent — nothing here is per-booking output, and a shape that
 * cannot name a booking cannot accidentally leak one onto a surface.
 */
export interface BookingFactSummary {
  readonly offeredAt: Date | null;
  readonly respondedAt: Date | null;
  readonly responseKind: string | null;
  readonly declineKind: string | null;
  readonly outcome: string | null;
  readonly outcomeAt: Date | null;
}

/**
 * Cohort rule for the rolling window: a booking is *recent* if it was
 * OFFERED inside it.
 *
 * The alternative — bounding each figure by its own most relevant date
 * (funnel on the offer, reliability on the outcome) — sounds more
 * precise and is worse, because it makes the acceptance rate and the
 * completion rate on the same panel describe two different sets of
 * bookings that happen to share a heading. A single cohort is also the
 * only version a surface can state in one sentence ("bookings requested
 * in the last 90 days"), and a figure a reviewer cannot restate is a
 * figure they cannot check.
 *
 * The cost is real and worth naming: a booking offered outside the
 * window but completed inside it does not count. Over a 90-day window
 * against bookings scheduled weeks ahead, that is a thin edge — but it
 * is the reason `firstObservedAt` and the lifetime figures ship
 * alongside, and never on their own.
 *
 * Rows with no known `offeredAt` (a `booking.created` that was never
 * seen) fall out of the recent window entirely. They still count for
 * lifetime, where no date is required.
 */
export function isWithinWindow(fact: BookingFactSummary, cutoff: Date): boolean {
  return fact.offeredAt !== null && fact.offeredAt.getTime() >= cutoff.getTime();
}

/** Cutoff instant for the rolling window, `now` minus the window. */
export function windowCutoff(now: Date, windowDays: number = PROVIDER_METRICS_WINDOW_DAYS): Date {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
}

/**
 * Count a set of facts.
 *
 * `decidedBookings` is the one derived number here, and it is the
 * denominator both reliability rates use: bookings this provider
 * ACCEPTED that have since reached a terminal position. Three
 * exclusions are deliberate.
 *
 *   - **Accepted but not yet finished** — neither a success nor a
 *     failure. Counting it as either would let a provider's completion
 *     rate move when nothing happened.
 *   - **Declined and expired offers** — never accepted, so they belong
 *     to the acceptance rate, not to reliability. Including them would
 *     mean a provider who declines work they cannot cover is scored as
 *     unreliable for doing exactly the right thing.
 *   - **Cancelled out of `pending`** — the booking was cancelled before
 *     the provider accepted it, so there was no commitment to break.
 *     The fact row keeps `canceled_previous_status` for precisely this
 *     test.
 */
export function countFacts(facts: readonly BookingFactSummary[]): ProviderMetricsCounts {
  let bookingsOffered = 0;
  let bookingsAccepted = 0;
  let bookingsDeclined = 0;
  let bookingsExpiredUnanswered = 0;
  let bookingsDeclinedByAdmin = 0;
  let bookingsCompleted = 0;
  let bookingsCanceledAfterAcceptance = 0;

  for (const fact of facts) {
    if (fact.offeredAt !== null) bookingsOffered += 1;

    if (fact.responseKind === 'accepted') bookingsAccepted += 1;
    if (fact.responseKind === 'declined') {
      if (fact.declineKind === 'window_expired') bookingsExpiredUnanswered += 1;
      else if (fact.declineKind === 'admin_declined') bookingsDeclinedByAdmin += 1;
      else bookingsDeclined += 1;
    }

    if (fact.outcome === 'completed') bookingsCompleted += 1;
    if (fact.outcome === 'canceled' && fact.responseKind === 'accepted') {
      bookingsCanceledAfterAcceptance += 1;
    }
  }

  return {
    bookingsOffered,
    bookingsAccepted,
    bookingsDeclined,
    bookingsExpiredUnanswered,
    bookingsDeclinedByAdmin,
    bookingsCompleted,
    bookingsCanceledAfterAcceptance,
    decidedBookings: bookingsCompleted + bookingsCanceledAfterAcceptance,
  };
}

/**
 * A rate in integer tenths of a percent, rounded half-up.
 *
 * Returns 0 for a zero denominator; callers must not reach here with
 * one, and the `state` discrimination is what stops them.
 */
export function toRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  const tenths = Math.round((numerator / denominator) * 1000);
  return Math.min(1000, Math.max(0, tenths));
}

/**
 * Offer-to-response gaps in whole seconds, for the bookings eligible to
 * have one.
 *
 * **Expiries are excluded**, and this is the subtle one. A
 * `window_expired` fact carries a `respondedAt` — the moment the offer
 * stopped being open — but nobody responded. Including it would report
 * the length of the accept window as the provider's response time,
 * making a provider who ignores every request look *consistent* rather
 * than absent. Their silence is already counted, in the acceptance
 * rate.
 *
 * Negative gaps (clock skew between producers, or a repaired row) are
 * dropped rather than clamped to zero: a zero is a claim that somebody
 * answered instantly, and we would be making it up.
 */
export function responseGapSeconds(facts: readonly BookingFactSummary[]): number[] {
  const gaps: number[] = [];
  for (const fact of facts) {
    if (fact.offeredAt === null || fact.respondedAt === null) continue;
    if (fact.declineKind === 'window_expired') continue;
    const seconds = Math.round((fact.respondedAt.getTime() - fact.offeredAt.getTime()) / 1000);
    if (seconds >= 0) gaps.push(seconds);
  }
  return gaps;
}

/**
 * Median of a sample, or null when the sample is empty.
 *
 * Even-length samples take the LOWER of the two middle values rather
 * than their mean. The figure is presented as "half of this provider's
 * responses came within X", which stays true of an observed value and
 * becomes an approximation the moment it is an average of two — and on
 * a two-sample provider the mean would be a number that describes
 * neither response.
 */
export function medianOf(sample: readonly number[]): number | null {
  if (sample.length === 0) return null;
  const sorted = [...sample].sort((a, b) => a - b);
  const middle = Math.floor((sorted.length - 1) / 2);
  return sorted[middle] ?? null;
}

/**
 * Turn a set of facts into one window's figures.
 *
 * The three-way discrimination is the whole point of this function:
 *
 *   - nothing at all → `no_activity`. Not a zero.
 *   - some history, fewer than `PROVIDER_METRICS_MIN_SAMPLE` decided
 *     bookings → `insufficient_data`, WITH the counts. A reviewer may
 *     see "two bookings, both completed"; they may not see "100%".
 *   - otherwise → `measured`.
 *
 * Note the floor is on DECIDED bookings, not on offers. A provider
 * sitting on twenty unanswered requests has not done anything a
 * completion rate can describe, and a floor on offers would let them
 * cross it without having.
 */
export function computeWindow(
  facts: readonly BookingFactSummary[],
  minimumDecided: number = PROVIDER_METRICS_MIN_SAMPLE,
): ProviderMetricsWindow {
  if (facts.length === 0) {
    return { state: 'no_activity' };
  }

  const counts = countFacts(facts);

  if (counts.decidedBookings < minimumDecided) {
    return { state: 'insufficient_data', counts, minimumDecidedBookings: minimumDecided };
  }

  // Offers the provider was in a position to answer. Admin declines are
  // excluded from BOTH sides of this fraction — they are not a refusal
  // by the provider and they are not an acceptance either, so leaving
  // them in the denominator alone would quietly depress the rate of
  // every provider ops has ever declined on behalf of.
  const answerable =
    counts.bookingsAccepted + counts.bookingsDeclined + counts.bookingsExpiredUnanswered;

  return {
    state: 'measured',
    counts,
    completionRate: toRate(counts.bookingsCompleted, counts.decidedBookings),
    cancellationRate: toRate(counts.bookingsCanceledAfterAcceptance, counts.decidedBookings),
    acceptanceRate: toRate(counts.bookingsAccepted, answerable),
    medianResponseSeconds: medianOf(responseGapSeconds(facts)),
  };
}

/**
 * Assemble the section carried on the dossier and the 360.
 *
 * `firstObservedAt` / `lastObservedAt` are the earliest and latest
 * instants this provider is known at all — offer, response or outcome,
 * whichever came first or last. They are not decorative: a lifetime
 * completion rate over three weeks and one over three years are
 * different claims wearing the same label, and nothing else on the
 * section tells them apart.
 */
export function computeMetricsSection(
  facts: readonly BookingFactSummary[],
  now: Date,
  windowDays: number = PROVIDER_METRICS_WINDOW_DAYS,
  minimumDecided: number = PROVIDER_METRICS_MIN_SAMPLE,
): ProviderMetricsSection {
  const cutoff = windowCutoff(now, windowDays);
  const recentFacts = facts.filter((fact) => isWithinWindow(fact, cutoff));

  let first: number | null = null;
  let last: number | null = null;
  for (const fact of facts) {
    for (const instant of [fact.offeredAt, fact.respondedAt, fact.outcomeAt]) {
      if (instant === null) continue;
      const time = instant.getTime();
      if (first === null || time < first) first = time;
      if (last === null || time > last) last = time;
    }
  }

  return {
    lifetime: computeWindow(facts, minimumDecided),
    recent: computeWindow(recentFacts, minimumDecided),
    windowDays,
    firstObservedAt: first === null ? null : new Date(first).toISOString(),
    lastObservedAt: last === null ? null : new Date(last).toISOString(),
    computedAt: now.toISOString(),
  };
}
