import Decimal from 'decimal.js';

/**
 * Pure money + date helpers for the Stripe → ledger reconciliation
 * (TS-261). Kept free of NestJS / IO so they are trivially unit-tested.
 *
 * **Money discipline.** Ledger figures come back from Prisma as
 * `Decimal(12, 2)`; Stripe figures arrive as integer minor units. We
 * normalise everything to integer minor units (cents) at the boundary and
 * compare integers — exact, never float (CLAUDE.md §17.6).
 */

const MS_PER_DAY = 86_400_000;

/** Format a `Date` as its UTC calendar-date key (`YYYY-MM-DD`). */
export function utcDayKey(at: Date): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  const day = String(at.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The default reconciliation day when no explicit `asOf` is supplied: the
 * most-recently-COMPLETED UTC day (yesterday relative to `now`). The
 * nightly worker fires after midnight UTC and reconciles the full day that
 * just ended — reconciling "today" would capture only the few hours since
 * midnight.
 */
export function defaultReconciliationDayKey(now: Date): string {
  return utcDayKey(new Date(now.getTime() - MS_PER_DAY));
}

/**
 * The `[start, end)` UTC-day window for a `YYYY-MM-DD` key. `start` is
 * midnight UTC of the day; `end` is midnight UTC of the next day
 * (exclusive). Used to bound the activity check's ledger movement query +
 * the Stripe balance-transaction `created` filter.
 */
export function dayWindowUtc(dayKey: string): { start: Date; end: Date } {
  const start = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`reconciliation: invalid day key "${dayKey}"`);
  }
  const end = new Date(start.getTime() + MS_PER_DAY);
  return { start, end };
}

/** Convert a `Decimal(12, 2)` dollar value to integer minor units (cents). */
export function decimalToMinor(value: Decimal): number {
  // Round once at the cent (CLAUDE.md §6). The DB column is already 2dp;
  // the `* 100` is exact for in-range values.
  return Number(value.mul(100).toFixed(0));
}

/** Convert integer minor units (cents) to a `Decimal` dollar value. */
export function minorToDecimal(minor: number): Decimal {
  return new Decimal(minor).div(100);
}

interface DecimalLike {
  toString(): string;
}

/**
 * Coerce a Prisma aggregate value (a `Decimal`-shaped object or null) to a
 * `Decimal`. Mirrors the trial-balance service's `toDecimal`.
 */
export function aggregateToDecimal(value: DecimalLike | null | undefined): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  if (value instanceof Decimal) return value;
  return new Decimal(value.toString());
}
