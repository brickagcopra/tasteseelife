/**
 * Pure scheduling helpers for the nightly accounting-metrics cadence
 * (TS-260). Kept free of NestJS / IO so they are trivially unit-tested.
 */

/** Format a `Date` as its UTC calendar-date key (`YYYY-MM-DD`). */
export function utcDayKey(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Should the compute fire on this tick? True only when the run hour has
 * been reached (UTC) AND this UTC day has not already been processed
 * in-process. The in-process `lastRunDayKey` guard prevents re-running
 * every tick within the same day; the idempotent (date-keyed) compute
 * makes a re-run after a restart harmless.
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
