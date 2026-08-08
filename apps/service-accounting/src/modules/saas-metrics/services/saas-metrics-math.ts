import Decimal from 'decimal.js';

/**
 * Pure SaaS-metrics math (TS-260, PDD §11.2 + §23.2).
 *
 * Kept free of NestJS / Prisma / IO so the money math — the part that
 * carries the 100%-coverage bar (CLAUDE.md §9.2) — is trivially
 * unit-tested.
 *
 * **MRR normalisation.** Each `deferred_revenue_balances` row carries the
 * subscription period's face value (`originalAmount`) over a window
 * (`servicePeriodStart` → `servicePeriodEnd`). A monthly plan's window is
 * ~30.4 days and its face value ≈ its monthly price; an annual plan's
 * window is 365 days and its face value is the annual price. Normalising
 * to a common monthly figure is therefore
 * `originalAmount × (avgDaysPerMonth / periodDays)` — a monthly plan
 * resolves to ≈ its monthly price, an annual plan to ≈ annual ÷ 12.
 *
 * **All math uses `Decimal`** and rounds once per balance to the cent
 * (CLAUDE.md §17.6 — never floats, round once). Per-subscription MRR is
 * the sum of its balances' cent-aligned values, so the aggregate MRR
 * (sum of per-subscription values) stays cent-aligned and the dashboard's
 * per-subscription drill-down reconciles to the headline exactly.
 *
 * **Retention ratios** cross the wire as integer parts-per-million
 * (`1.0` = 1,000,000 ppm) so the float-free posture extends to ratios.
 */

/** Average days per month — `365.25 / 12`. */
export const AVG_DAYS_PER_MONTH = new Decimal('30.4375');

/** Milliseconds per day. */
export const MS_PER_DAY = 86_400_000;

/** One ratio unit in parts-per-million — `1.0` (100%) === 1,000,000 ppm. */
export const PPM_SCALE = 1_000_000;

/**
 * Normalise a single balance's face value to a monthly recurring figure,
 * rounded to the cent.
 *
 * Returns `0` for a degenerate / inverted period (`end <= start`) — such a
 * row contributes no recurring revenue rather than dividing by zero or a
 * negative.
 *
 * **Suspended time is excluded from the period (TS-042-followup-3b2).**
 * Resuming a paused subscription extends `service_period_end` by the
 * suspended duration, so a $299 month that spent ten days paused becomes
 * a 40-day period. Dividing the face value across all 40 calendar days
 * would normalise it to ~$227 and register a $72 contraction in the
 * movement metrics — a revenue drop that never happened. Netting off
 * `pausedDurationSeconds` restores the 30-day service period, and with it
 * the pre-pause MRR. The subscription still leaves the MRR base entirely
 * for the days it is actually paused (the snapshot query filters
 * `status: 'active'`, which a paused balance is not) — that absence is
 * real and intended; this correction is only about the period AFTER
 * service resumes.
 */
export function normalizeMonthlyMrr(args: {
  readonly originalAmount: Decimal;
  readonly servicePeriodStart: Date;
  readonly servicePeriodEnd: Date;
  /** Accumulated suspended seconds on the balance. `0` if never paused. */
  readonly pausedDurationSeconds: number;
}): Decimal {
  const durationMs =
    args.servicePeriodEnd.getTime() -
    args.servicePeriodStart.getTime() -
    args.pausedDurationSeconds * 1_000;
  if (durationMs <= 0) {
    return new Decimal(0);
  }
  const periodDays = new Decimal(durationMs).div(MS_PER_DAY);
  return args.originalAmount
    .mul(AVG_DAYS_PER_MONTH)
    .div(periodDays)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * Compute ARPU = `mrr / activeSubscriptions`, rounded to the cent.
 * Returns `0` when there are no active subscriptions (avoids a
 * divide-by-zero and matches the "no subscribers → no per-subscriber
 * revenue" reading).
 */
export function computeArpu(mrr: Decimal, activeSubscriptions: number): Decimal {
  if (activeSubscriptions <= 0) {
    return new Decimal(0);
  }
  return mrr.div(activeSubscriptions).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export interface MovementResult {
  readonly newMrr: Decimal;
  readonly expansionMrr: Decimal;
  readonly contractionMrr: Decimal;
  readonly churnedMrr: Decimal;
  readonly churnedSubscriptions: number;
  readonly netNewMrr: Decimal;
  readonly priorMrr: Decimal;
  /** Net revenue retention ratio. Null when there is no prior baseline. */
  readonly netRevenueRetention: Decimal | null;
  /** Gross revenue retention ratio. Null when there is no prior baseline. */
  readonly grossRevenueRetention: Decimal | null;
}

/**
 * Decompose period-over-period MRR movement.
 *
 * Compares the current per-subscription MRR map against the prior
 * snapshot's map (cent-aligned `Decimal` values keyed by subscription
 * id):
 *
 *   - **new**         — subscriptions present today, absent in prior.
 *   - **expansion**   — present in both, today > prior (the increase).
 *   - **contraction** — present in both, today < prior (the decrease).
 *   - **churned**     — present in prior, absent today (the lost MRR + count).
 *
 * Retention (only definable when there IS a prior baseline AND prior MRR
 * is non-zero):
 *
 *   - **NRR** = `(prior + expansion − contraction − churned) / prior`
 *   - **GRR** = `(prior − contraction − churned) / prior`
 *
 * When `prior` is `null` (the first-ever run) every subscription is
 * "new", movement is otherwise zero, and retention is undefined (`null`).
 */
export function decomposeMovement(args: {
  readonly current: ReadonlyMap<string, Decimal>;
  readonly prior: ReadonlyMap<string, Decimal> | null;
}): MovementResult {
  const { current, prior } = args;

  if (prior === null) {
    let newMrr = new Decimal(0);
    for (const mrr of current.values()) {
      newMrr = newMrr.add(mrr);
    }
    return {
      newMrr,
      expansionMrr: new Decimal(0),
      contractionMrr: new Decimal(0),
      churnedMrr: new Decimal(0),
      churnedSubscriptions: 0,
      netNewMrr: newMrr,
      priorMrr: new Decimal(0),
      netRevenueRetention: null,
      grossRevenueRetention: null,
    };
  }

  let newMrr = new Decimal(0);
  let expansionMrr = new Decimal(0);
  let contractionMrr = new Decimal(0);
  let churnedMrr = new Decimal(0);
  let churnedSubscriptions = 0;
  let priorMrr = new Decimal(0);

  for (const [subscriptionId, currentMrr] of current) {
    const priorMrrForSub = prior.get(subscriptionId);
    if (priorMrrForSub === undefined) {
      newMrr = newMrr.add(currentMrr);
      continue;
    }
    const delta = currentMrr.sub(priorMrrForSub);
    if (delta.gt(0)) {
      expansionMrr = expansionMrr.add(delta);
    } else if (delta.lt(0)) {
      contractionMrr = contractionMrr.add(delta.abs());
    }
  }

  for (const [subscriptionId, priorMrrForSub] of prior) {
    priorMrr = priorMrr.add(priorMrrForSub);
    if (!current.has(subscriptionId)) {
      churnedMrr = churnedMrr.add(priorMrrForSub);
      churnedSubscriptions += 1;
    }
  }

  const netNewMrr = newMrr.add(expansionMrr).sub(contractionMrr).sub(churnedMrr);

  let netRevenueRetention: Decimal | null = null;
  let grossRevenueRetention: Decimal | null = null;
  if (priorMrr.gt(0)) {
    const retained = priorMrr.sub(contractionMrr).sub(churnedMrr);
    netRevenueRetention = clampNonNegative(
      retained.add(expansionMrr).div(priorMrr),
    ).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
    grossRevenueRetention = clampNonNegative(retained.div(priorMrr)).toDecimalPlaces(
      6,
      Decimal.ROUND_HALF_UP,
    );
  }

  return {
    newMrr,
    expansionMrr,
    contractionMrr,
    churnedMrr,
    churnedSubscriptions,
    netNewMrr,
    priorMrr,
    netRevenueRetention,
    grossRevenueRetention,
  };
}

/** Convert a `Decimal` ratio to integer parts-per-million. */
export function ratioToPpm(ratio: Decimal | null): number | null {
  if (ratio === null) {
    return null;
  }
  return Number(ratio.mul(PPM_SCALE).toFixed(0));
}

/** Convert `Decimal` dollars to integer minor units (cents). */
export function decimalToMinor(value: Decimal): number {
  return Number(value.mul(100).toFixed(0));
}

/**
 * Coerce Prisma's runtime Decimal (or any decimal-string-compatible
 * value) into a `decimal.js` instance. Mirrors the `asDecimal` helper in
 * `subscription-revenue-recognizer.service.ts`.
 */
export function asDecimal(value: unknown): Decimal {
  if (value instanceof Decimal) {
    return value;
  }
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return new Decimal((value as { toString(): string }).toString());
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return new Decimal(value);
  }
  throw new Error(`saas-metrics: unexpected non-Decimal value: ${String(value)}`);
}

/** Truncate a timestamp to its UTC calendar date (midnight UTC). */
export function toUtcDateOnly(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** Format a `Date` as the canonical `YYYY-MM-DD` UTC calendar-date key. */
export function utcDateKey(at: Date): string {
  const year = at.getUTCFullYear();
  const month = (at.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = at.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function clampNonNegative(value: Decimal): Decimal {
  return value.lt(0) ? new Decimal(0) : value;
}
