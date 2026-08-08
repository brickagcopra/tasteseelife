/**
 * Pure scheduling helpers for the monthly wellness-summary cadence
 * (TS-235). Kept free of NestJS / IO so they are trivially unit-tested.
 */

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export interface ResolvedPeriod {
  /**
   * Idempotency identity for the run, `YYYY-MM` of the run month. The
   * deterministic dispatch keys embed this so a re-run of the same month
   * collapses against the original dispatch rows.
   */
  readonly periodKey: string;
  /**
   * Human label for the period the summary REPORTS on — the calendar
   * month that just ended (a run on the 1st reports the prior month).
   * `Date.UTC(y, m - 1, 1)` rolls a January run back to the prior
   * December correctly.
   */
  readonly periodLabel: string;
}

export function resolvePeriod(now: Date): ResolvedPeriod {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-11
  const periodKey = `${year}-${String(month + 1).padStart(2, '0')}`;

  const priorMonthStart = new Date(Date.UTC(year, month - 1, 1));
  const priorName = MONTH_NAMES[priorMonthStart.getUTCMonth()] ?? 'the prior month';
  const periodLabel = `${priorName} ${priorMonthStart.getUTCFullYear()}`;

  return { periodKey, periodLabel };
}

/**
 * Should the batch run on this tick? True only when the run window has
 * been reached (day-of-month ≥ runDay AND hour ≥ runHour, both UTC) AND
 * this period has not already been processed in-process. The in-process
 * `lastRunPeriod` guard prevents re-running every tick within the same
 * month; deterministic dispatch idempotency keys make a re-run after a
 * restart harmless (every dispatch replays).
 */
export function shouldRunNow(args: {
  readonly now: Date;
  readonly runDayOfMonth: number;
  readonly runHourUtc: number;
  readonly lastRunPeriod: string | undefined;
}): boolean {
  const { now, runDayOfMonth, runHourUtc, lastRunPeriod } = args;
  if (now.getUTCDate() < runDayOfMonth) return false;
  if (now.getUTCDate() === runDayOfMonth && now.getUTCHours() < runHourUtc) return false;
  const { periodKey } = resolvePeriod(now);
  return periodKey !== lastRunPeriod;
}
