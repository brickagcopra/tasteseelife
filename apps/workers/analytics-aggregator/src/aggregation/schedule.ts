/**
 * Pure scheduling helpers for the nightly analytics-aggregator cadence
 * (TS-217-prep-3b). Kept free of NestJS / IO so they are trivially
 * unit-tested.
 *
 * **Previous-day targeting.** Unlike the accounting-metrics worker — which
 * triggers a point-in-time "as of now" snapshot — this worker aggregates a
 * full UTC calendar DAY of raw events. Running at 03:00 UTC for "today" would
 * capture only the first three hours, so the worker targets the PREVIOUS
 * complete UTC day. `previousUtcDayKey` derives that target; the in-process
 * run guard still keys on `utcDayKey(now)` (today) so the job fires once per
 * calendar day.
 */

/** Milliseconds in a 24-hour UTC day. */
const MS_PER_UTC_DAY = 24 * 60 * 60 * 1000;

/** Format a `Date` as its UTC calendar-date key (`YYYY-MM-DD`). */
export function utcDayKey(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The UTC calendar date one day before `now`'s date — the complete day this
 * run aggregates. Computed by stepping back from `now`'s UTC midnight, so the
 * result is independent of the time-of-day the run fires.
 */
export function previousUtcDayKey(now: Date): string {
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return utcDayKey(new Date(todayStartMs - MS_PER_UTC_DAY));
}

/**
 * The start-of-day ISO instant for a `YYYY-MM-DD` key. Sent as the `asOf` to
 * the compute endpoint so service-analytics resolves the matching UTC-day
 * window (`toUtcDayWindow`).
 */
export function startOfUtcDayIso(dayKey: string): string {
  return `${dayKey}T00:00:00.000Z`;
}

/**
 * Should the aggregation fire on this tick? True only when the run hour has
 * been reached (UTC) AND this UTC day has not already been processed
 * in-process. The in-process `lastRunDayKey` guard prevents re-running every
 * tick within the same day; the idempotent (date-keyed) compute makes a
 * re-run after a restart harmless.
 */
export function shouldRunNow(args: {
  readonly now: Date;
  readonly runHourUtc: number;
  readonly lastRunDayKey: string | undefined;
}): boolean {
  const { now, runHourUtc, lastRunDayKey } = args;
  if (now.getUTCHours() < runHourUtc) {
    return false;
  }
  return utcDayKey(now) !== lastRunDayKey;
}
