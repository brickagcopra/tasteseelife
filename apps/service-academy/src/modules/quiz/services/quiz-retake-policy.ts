/**
 * Pure retake-policy evaluation (TS-254; PRD §9.2 "retake policy configurable").
 *
 * Decides whether a student may START a new attempt at a quiz, given the quiz's
 * policy and a summary of the student's prior attempts. Extracted as a pure
 * function (clock injected) so the branch matrix is exhaustively testable.
 *
 * Order of checks:
 *   1. `attempt_in_progress` — an un-submitted attempt already exists (finish it
 *      first; the engine allows only one open attempt per student per quiz).
 *   2. `max_attempts_reached` — the total-attempts cap is hit.
 *   3. `cooldown_active` — the wait since the last submitted attempt has not
 *      elapsed (carries the `retryAfter` instant for the client).
 * Otherwise the start is allowed and the 1-based `attemptNumber` is returned.
 */

/** The quiz's configured retake policy. `null` means unlimited / no cooldown. */
export interface RetakePolicy {
  readonly maxAttempts: number | null;
  readonly retakeCooldownMinutes: number | null;
}

/** A summary of a student's prior attempts at one quiz. */
export interface PriorAttemptsSummary {
  /** Total attempts at this quiz, any status. */
  readonly totalCount: number;
  /** Whether an un-submitted (`in_progress`) attempt exists. */
  readonly hasInProgress: boolean;
  /** The most recent submitted attempt's `submittedAt`, or null if none. */
  readonly lastSubmittedAt: Date | null;
}

export type RetakeDecision =
  | { readonly ok: true; readonly attemptNumber: number }
  | { readonly ok: false; readonly reason: 'attempt_in_progress' }
  | { readonly ok: false; readonly reason: 'max_attempts_reached' }
  | { readonly ok: false; readonly reason: 'cooldown_active'; readonly retryAfter: Date };

const MILLIS_PER_MINUTE = 60_000;

export function evaluateRetakePolicy(
  policy: RetakePolicy,
  prior: PriorAttemptsSummary,
  now: Date,
): RetakeDecision {
  if (prior.hasInProgress) {
    return { ok: false, reason: 'attempt_in_progress' };
  }

  if (policy.maxAttempts !== null && prior.totalCount >= policy.maxAttempts) {
    return { ok: false, reason: 'max_attempts_reached' };
  }

  if (policy.retakeCooldownMinutes !== null && prior.lastSubmittedAt !== null) {
    const retryAfter = new Date(
      prior.lastSubmittedAt.getTime() + policy.retakeCooldownMinutes * MILLIS_PER_MINUTE,
    );
    if (now.getTime() < retryAfter.getTime()) {
      return { ok: false, reason: 'cooldown_active', retryAfter };
    }
  }

  return { ok: true, attemptNumber: prior.totalCount + 1 };
}
