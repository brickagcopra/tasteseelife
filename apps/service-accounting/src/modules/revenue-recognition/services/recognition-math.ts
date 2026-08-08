import Decimal from 'decimal.js';

/**
 * Pure recognition-math helpers for the daily-sweep driver.
 *
 * Subscription revenue is recognised over the service period
 * (CLAUDE.md §17.17, PDD Appendix A "Month elapses on $299 sub →
 * DR Deferred Revenue $299 / CR Subscription Revenue $299"). The
 * recognizer treats the period as continuous time and uses
 * **cumulative rounding** — the expected total recognised at any
 * point in time is `originalAmount * elapsedTime / totalTime`,
 * rounded to the cent; the daily delta is `expectedCumulative -
 * alreadyRecognised`. Cumulative rounding ensures pennies don't
 * accumulate across sweeps.
 *
 * **Final-day fully-zeroes invariant.** On or after `periodEnd`,
 * `expectedCumulative = originalAmount` exactly, regardless of
 * rounding leftover from prior daily increments. The last sweep
 * always closes the balance to zero deferred.
 *
 * **Negative-delta protection.** If a sweep runs slightly out of
 * order (e.g. asOf = yesterday morning after asOf = yesterday
 * evening already ran), the computed delta could be negative.
 * The recognizer clamps to zero — never posts a reverse-direction
 * recognition. Cumulative correctness re-establishes naturally
 * on the next sweep.
 *
 * **Pause windows are excluded from elapsed time (TS-042-followup-3b2).**
 * A paused subscription delivers no service, so its suspended time
 * must not amortise. `pausedDurationMs` is subtracted from BOTH the
 * elapsed numerator and the total denominator; because
 * `SubscriptionRevenueRecognizerService.resumeRecognition` extends
 * `servicePeriodEnd` by exactly that same duration, the denominator
 * `(end - start) - paused` stays *identical* to the original service
 * duration across any number of pause cycles. Two consequences worth
 * stating because they are the whole design:
 *   1. On resume the cumulative expected value equals what was already
 *      recognised at the moment of the pause, so the delta is zero —
 *      recognition picks up exactly where it stopped instead of
 *      catching up every paused day in one journal.
 *   2. No journal posted before the pause is retroactively wrong, so
 *      the extension owes no reversal / replacement pair (CLAUDE.md §6).
 *
 * **All math uses `Decimal`.** Inputs cross the wire as integer
 * minor units; conversion to/from `Decimal(12, 2)` dollars happens
 * at the service boundary.
 */

export interface RecognitionDeltaInput {
  readonly originalAmount: Decimal;
  readonly alreadyRecognized: Decimal;
  readonly servicePeriodStart: Date;
  readonly servicePeriodEnd: Date;
  readonly asOf: Date;
  /**
   * Accumulated suspended time across every completed pause window,
   * in milliseconds. `0` for a balance that has never been paused.
   *
   * REQUIRED rather than defaulted: the single production call site
   * reads it off the balance row, and a defaulted field is exactly the
   * kind that ships un-wired (TS-308c-followup-2). A compile error at
   * the call site beats a silent zero that quietly recognises revenue
   * for days nobody was served.
   */
  readonly pausedDurationMs: number;
}

export interface RecognitionDeltaResult {
  /** Cumulative expected recognised AT `asOf`, rounded to the cent. */
  readonly expectedCumulative: Decimal;
  /** Amount to recognise this sweep (clamped to zero on negative). */
  readonly delta: Decimal;
  /** True when `asOf >= servicePeriodEnd` (final-day sweep). */
  readonly isFinalRecognition: boolean;
  /** True when `delta > 0` — the sweep should post a journal. */
  readonly hasRecognitionDue: boolean;
}

/**
 * Compute the recognition delta for a single balance at a given
 * point in time.
 *
 * Pre-conditions (enforced by the contract layer + the schema):
 *   - `servicePeriodStart` < `servicePeriodEnd`
 *   - `originalAmount >= 0`
 *   - `alreadyRecognized >= 0` AND `alreadyRecognized <= originalAmount`
 *
 * Returns `delta = 0` (and `hasRecognitionDue = false`) when:
 *   - `asOf <= servicePeriodStart` (period not yet started)
 *   - service-elapsed time is zero or negative once accumulated pause
 *     time is removed (the balance has been suspended for the whole of
 *     the calendar time since the period opened)
 *   - `alreadyRecognized` already matches the cumulative expected
 *   - the cumulative expected rounded down to the same cent as
 *     `alreadyRecognized` (no daily increment is due yet)
 */
export function computeRecognitionDelta(input: RecognitionDeltaInput): RecognitionDeltaResult {
  const {
    originalAmount,
    alreadyRecognized,
    servicePeriodStart,
    servicePeriodEnd,
    asOf,
    pausedDurationMs,
  } = input;

  const periodStartMs = servicePeriodStart.getTime();
  const periodEndMs = servicePeriodEnd.getTime();
  const asOfMs = asOf.getTime();

  if (asOfMs <= periodStartMs) {
    return {
      expectedCumulative: new Decimal(0),
      delta: new Decimal(0),
      isFinalRecognition: false,
      hasRecognitionDue: false,
    };
  }

  const isFinalRecognition = asOfMs >= periodEndMs;

  // Service time excludes every completed pause window. Subtracting the
  // accumulated total (rather than only the windows preceding `asOf`) is
  // safe because the sweep never sees a balance mid-pause — a paused row
  // is not `active` — so by the time any sweep reads this value every
  // window it covers is already closed and in the past.
  const totalServiceMs = periodEndMs - periodStartMs - pausedDurationMs;
  const elapsedServiceMs = asOfMs - periodStartMs - pausedDurationMs;

  if (!isFinalRecognition && (elapsedServiceMs <= 0 || totalServiceMs <= 0)) {
    // Nothing has been served yet (the whole elapsed window was
    // suspended), or the period carries more pause than calendar — the
    // latter is unreachable while resume extends the period end in step,
    // and is guarded rather than divided by.
    return {
      expectedCumulative: new Decimal(0),
      delta: new Decimal(0),
      isFinalRecognition: false,
      hasRecognitionDue: false,
    };
  }

  let expectedCumulative: Decimal;
  if (isFinalRecognition) {
    // Final-day sweep zeroes out the remaining deferred regardless
    // of rounding leftover from prior daily increments.
    expectedCumulative = originalAmount;
  } else {
    const totalDurationMs = totalServiceMs;
    const elapsedMs = elapsedServiceMs;
    // Pure-Decimal arithmetic — never coerce to Number for money math.
    const fraction = new Decimal(elapsedMs).div(totalDurationMs);
    const raw = originalAmount.mul(fraction);
    expectedCumulative = raw.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    // Clamp upper bound — `originalAmount` is the ceiling regardless
    // of any odd rounding edge.
    if (expectedCumulative.gt(originalAmount)) {
      expectedCumulative = originalAmount;
    }
  }

  const rawDelta = expectedCumulative.sub(alreadyRecognized);
  // Clamp negative deltas to zero — never run recognition in reverse.
  // The next forward-only sweep re-establishes cumulative correctness.
  const delta = rawDelta.lt(0) ? new Decimal(0) : rawDelta;

  return {
    expectedCumulative,
    delta,
    isFinalRecognition,
    hasRecognitionDue: delta.gt(0),
  };
}

/**
 * Convert wire-shape integer minor units to `Decimal(12, 2)` dollars.
 * Mirrors the converter in `journal-posting.service.ts` — kept as a
 * private helper to this module so the recognition math doesn't
 * cross-import.
 */
export function minorToDecimal(minor: number): Decimal {
  return new Decimal(minor).div(100);
}

/**
 * Convert `Decimal` dollars back to integer minor units. The mapper
 * layer + wire shape use this on the boundary.
 */
export function decimalToMinor(d: Decimal): number {
  return Number(d.mul(100).toFixed(0));
}

/**
 * Format a `Date` as the canonical daily-source-event suffix
 * (`YYYY-MM-DD` in UTC). The daily-recognition journals carry
 * `subscription.recognized:{subscriptionId}:{thisString}` as the
 * source event id — idempotency at the journal layer is bounded
 * by calendar day in UTC.
 */
export function asOfDailySuffix(asOf: Date): string {
  const year = asOf.getUTCFullYear();
  const month = (asOf.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = asOf.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}
