import type {
  AdminPausedDeferredRevenueBalance,
  AdminPausedDeferredRevenueResponse,
} from '@taste-and-see/contracts';

/**
 * Rendering rules for the paused deferred-revenue queue
 * (TS-042-followup-3b2-followup-2a).
 *
 * **Why a `.ts` module rather than inline in the page.** web-admin's test
 * lane excludes `.tsx` on purpose (TS-303c2b-followup-1) — a server
 * component's body is `await fetch` plus JSX and belongs to Playwright.
 * What lives here is not rendering: it is what a duration means, and what
 * an operator must be told about the numbers above the table. Both are
 * worth asserting.
 *
 * **The wording states measurements, never verdicts.** A subscription
 * pause is a legitimate product feature — a family suspending care during
 * a hospital stay — so nothing here calls a long pause wrong. The two
 * facts the page does assert both come off the row: a pause that has
 * outlasted its own service period, and a pause whose start was never
 * recorded.
 */

export interface DescribedPausedBalance {
  /**
   * Human-readable age of the current pause window, or **null** when the
   * balance carries no pause instant. Null rather than "0 seconds": a row
   * whose age cannot be established is the least diagnosable one on a
   * queue sorted by age, and rendering it as the freshest is exactly
   * backwards.
   */
  readonly age: string | null;
}

export interface DescribedPausedQueue {
  /**
   * Caveats the reader needs BEFORE the numbers mean anything. Empty when
   * the queue is unambiguous — an unconditional caveat that is usually
   * false trains people to skip it.
   */
  readonly notes: readonly string[];
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;

export function describePausedBalance(
  balance: AdminPausedDeferredRevenueBalance,
): DescribedPausedBalance {
  return { age: formatDuration(balance.pausedForSeconds) };
}

export function describePausedQueue(
  queue: AdminPausedDeferredRevenueResponse,
): DescribedPausedQueue {
  const notes: string[] = [];

  if (queue.truncated) {
    // The counts above the table are computed over every paused balance;
    // only the table is capped. Saying so is what stops a reader treating
    // the rows as the whole set.
    notes.push(
      `Showing the ${queue.balances.length} longest-suspended of ${queue.summary.pausedCount} paused balances. The totals above cover all of them.`,
    );
  }

  const unknown = queue.summary.unknownPausedAtCount;
  if (unknown > 0) {
    notes.push(
      `${unknown} ${unknown === 1 ? 'balance has' : 'balances have'} no recorded pause instant, so ${unknown === 1 ? 'its' : 'their'} suspension cannot be aged and ${unknown === 1 ? 'it is' : 'they are'} not represented in the oldest-pause figure.`,
    );
  }

  const expired = queue.summary.pastServicePeriodEndCount;
  if (expired > 0) {
    notes.push(
      `${expired} ${expired === 1 ? 'balance is' : 'balances are'} past the end of the service period ${expired === 1 ? 'it belongs' : 'they belong'} to. A resume extends that period by the suspended time, so an end date already in the past means recognition stopped with nothing scheduled to restart it.`,
    );
  }

  return { notes };
}

/**
 * Whole-unit duration, rounded DOWN to the largest unit that fits.
 *
 * Down, not nearest: this number is read as "at least this long", and a
 * pause of 23 hours reported as "1 day" overstates a measurement an
 * operator may act on. Same posture as the email-expiry copy in
 * TS-510-followup-4.
 */
function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
  if (seconds < SECONDS_PER_HOUR) {
    return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m`;
  }
  if (seconds < SECONDS_PER_DAY) {
    return `${Math.floor(seconds / SECONDS_PER_HOUR)}h`;
  }
  return `${Math.floor(seconds / SECONDS_PER_DAY)}d`;
}
