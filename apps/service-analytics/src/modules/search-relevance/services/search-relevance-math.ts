import { SEARCH_RELEVANCE_PPM_SCALE } from '@taste-and-see/contracts';

/**
 * Pure helpers for the nightly search-relevance aggregation
 * (TS-217-prep-3b). Kept free of NestJS / Prisma / IO so they are trivially
 * unit-tested — the same split as the accounting `saas-metrics-math` module.
 */

/** Milliseconds in a 24-hour UTC day. UTC has no DST, so this is exact. */
const MS_PER_UTC_DAY = 24 * 60 * 60 * 1000;

/**
 * A half-open UTC calendar-day window: `[dayStart, dayEnd)`. The aggregation
 * reads `search_events` / `booking_created_events` whose `occurred_at` falls
 * in `[dayStart, dayEnd)` and writes the marts keyed by `dayStart` (a
 * `@db.Date`). `dateKey` is the `YYYY-MM-DD` form for the wire + logs.
 */
export interface UtcDayWindow {
  /** Inclusive lower bound — 00:00:00.000 UTC of the metric date. */
  readonly dayStart: Date;
  /** Exclusive upper bound — 00:00:00.000 UTC of the following day. */
  readonly dayEnd: Date;
  /** `YYYY-MM-DD` UTC calendar-date key. */
  readonly dateKey: string;
}

/** Format a `Date` as its UTC calendar-date key (`YYYY-MM-DD`). */
export function utcDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Resolve the half-open UTC day window containing `asOf`. The window the
 * aggregation operates on — `dayStart` is the metric date the marts are
 * keyed by; `dayEnd` is exclusive so two adjacent days never double-count a
 * midnight event.
 */
export function toUtcDayWindow(asOf: Date): UtcDayWindow {
  const dayStart = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + MS_PER_UTC_DAY);
  return { dayStart, dayEnd, dateKey: utcDateKey(dayStart) };
}

/**
 * Express `numerator / denominator` as an integer parts-per-million rate
 * (`0.05` → `50_000`), or `null` when the denominator is zero (an undefined
 * rate — no searches → no zero-result rate; no searchers → no conversion).
 * Rounds to the nearest ppm so the wire stays float-free (CLAUDE.md §6 — the
 * money-math round-once discipline applied to ratios).
 */
export function rateToPpm(numerator: number, denominator: number): number | null {
  if (denominator <= 0) {
    return null;
  }
  return Math.round((numerator / denominator) * SEARCH_RELEVANCE_PPM_SCALE);
}

/**
 * One bucket of the first-page result-count histogram: `searchCount`
 * first-page searches each returned exactly `resultCount` hits. Sourced from a
 * `searchEvent.groupBy({ by: ['resultCount'], page: 'first' })` over the day
 * window (TS-217-prep-4b-followup-1).
 */
export interface ResultCountBucket {
  /** Hits returned on the first page of this group of searches. */
  readonly resultCount: number;
  /** How many first-page searches returned exactly that many hits. */
  readonly searchCount: number;
}

/**
 * Per-position IMPRESSION denominator for the CTR-by-position mart
 * (TS-217-prep-4b-followup-1).
 *
 * A first-page search that returned `resultCount` hits rendered result
 * positions `0 .. resultCount-1`, so position `p` was shown (an impression)
 * exactly when `resultCount > p`. Given the first-page result-count histogram
 * (`buckets`) and the set of `positions` that received at least one click that
 * day, returns `impressions[p]` for each requested position as a Map.
 *
 * **First-page grain (caveat).** The denominator counts FIRST-PAGE impressions
 * only — matching the prep-3b first-page aggregation grain — while a click can
 * originate from any page (the family-portal stamps the click position as the
 * rank within the page the user saw). At Phase-1 scale pagination is rare, so
 * this is a faithful first-page CTR; the dashboard guards a zero denominator
 * (an undefined CTR) the same way `rateToPpm` does.
 *
 * O(positions × buckets); both are bounded by the first-page size cap
 * (`PROVIDER_DISCOVERY_LIMIT_MAX = 100`), so this is a small in-process fold.
 */
export function impressionsForPositions(
  buckets: readonly ResultCountBucket[],
  positions: readonly number[],
): Map<number, number> {
  const out = new Map<number, number>();
  for (const position of positions) {
    let impressions = 0;
    for (const bucket of buckets) {
      if (bucket.resultCount > position) {
        impressions += bucket.searchCount;
      }
    }
    out.set(position, impressions);
  }
  return out;
}

/**
 * Precise per-search attribution numerator for the query→booking conversion
 * mart (TS-217-prep-4c-followup-1).
 *
 * Counts how many `bookingSearchIds` (the `search_id` token echoed onto each
 * `booking.created`, one entry per booking in the window) point at a search
 * that actually occurred in the same window — i.e. a `search_id` present in
 * `searchEventIds` (the set of `search_events.event_id`s for the window). A
 * null/undefined token (a booking that did not arrive from a search — concierge
 * manual booking, direct-link visit) never matches, so it is excluded. Each
 * booking is counted independently, so two bookings sharing one `search_id`
 * (an unusual double-conversion) both count.
 *
 * Pure + IO-free so it is trivially unit-tested; the service supplies the two
 * id lists from bounded same-window reads (Phase-1 scale: hundreds/day,
 * PDD §27).
 */
export function countAttributedBookings(
  bookingSearchIds: readonly (string | null | undefined)[],
  searchEventIds: Iterable<string>,
): number {
  const eventIds = new Set(searchEventIds);
  let count = 0;
  for (const searchId of bookingSearchIds) {
    if (searchId != null && eventIds.has(searchId)) {
      count += 1;
    }
  }
  return count;
}
