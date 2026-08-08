import {
  resolveCertificationRenewalThreshold,
  type AcademyCertificationRenewalThresholdDays,
} from '@taste-and-see/contracts';

/**
 * Pure scheduling + classification helpers for the daily
 * certification-renewal cadence (TS-256). Kept free of NestJS / IO so they
 * are trivially unit-tested.
 */

const MS_PER_DAY = 86_400_000;

export interface ResolvedPeriod {
  /**
   * Idempotency identity for the run, `YYYY-MM-DD` (UTC) of the run day.
   * The in-process last-run guard compares against it so the batch fires
   * at most once per UTC day even though the scheduler ticks hourly.
   */
  readonly periodKey: string;
}

export function resolveDailyPeriod(now: Date): ResolvedPeriod {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return { periodKey: `${year}-${month}-${day}` };
}

/**
 * Should the batch run on this tick? True only when the run hour has been
 * reached (hour ≥ runHour, UTC) AND this UTC day has not already been
 * processed in-process. The in-process `lastRunPeriod` guard prevents
 * re-running every tick within the same day; the deterministic dispatch
 * idempotency keys make a re-run after a restart harmless (every milestone
 * dispatch replays, every expire is idempotent).
 */
export function shouldRunNow(args: {
  readonly now: Date;
  readonly runHourUtc: number;
  readonly lastRunPeriod: string | undefined;
}): boolean {
  const { now, runHourUtc, lastRunPeriod } = args;
  if (now.getUTCHours() < runHourUtc) return false;
  const { periodKey } = resolveDailyPeriod(now);
  return periodKey !== lastRunPeriod;
}

/**
 * Classification of one renewal candidate against the current clock.
 *
 *   - `lapsed`   — expiry is at or past `now`; the worker issues the
 *                  idempotent `expire` write (active → expired).
 *   - `reminder` — expiry is in the future and `daysUntilExpiry` maps to a
 *                  90 / 60 / 30 / 7-day milestone; the worker dispatches
 *                  the milestone email (keyed on `milestoneDays`).
 *   - `skip`     — expiry is in the future but no milestone applies
 *                  (between milestones, or beyond the 90-day window); the
 *                  worker does nothing this run.
 */
export type RenewalClassification =
  | { readonly kind: 'lapsed' }
  | {
      readonly kind: 'reminder';
      readonly daysUntilExpiry: number;
      readonly milestoneDays: AcademyCertificationRenewalThresholdDays;
    }
  | { readonly kind: 'skip'; readonly daysUntilExpiry: number };

export function classifyRenewalCandidate(expiresAtIso: string, now: Date): RenewalClassification {
  const expiresMs = Date.parse(expiresAtIso);
  const nowMs = now.getTime();
  if (!Number.isFinite(expiresMs)) {
    // Defensive — the contract guarantees a valid ISO string, but a
    // malformed value should be skipped, not crash the run.
    return { kind: 'skip', daysUntilExpiry: Number.NaN };
  }
  if (expiresMs <= nowMs) return { kind: 'lapsed' };

  const daysUntilExpiry = Math.floor((expiresMs - nowMs) / MS_PER_DAY);
  const milestoneDays = resolveCertificationRenewalThreshold(daysUntilExpiry);
  if (milestoneDays === null) return { kind: 'skip', daysUntilExpiry };
  return { kind: 'reminder', daysUntilExpiry, milestoneDays };
}
