import { z } from 'zod';

import {
  WELLNESS_TREND_SCORE_MAX,
  WELLNESS_TREND_SCORE_MIN,
  WELLNESS_TREND_SENIOR_ID_MAX_LENGTH,
  WellnessTrendMetricSchema,
  WellnessTrendWindowDaysSchema,
  type WellnessTrendMetric,
  type WellnessTrendSeries,
} from './wellness-trends.schema';

/**
 * Wellness-anomaly detection DTOs + detector (TS-236; PRD §6.9; PDD §23.1).
 *
 * TS-231 plots a senior's recent wellness observations as per-visit
 * trend lines. TS-236 adds the *early-warning* layer on top of the same
 * data: a lightweight statistical detector that flags when a scale has
 * been *declining* relative to the senior's own recent baseline — so an
 * adult child (and, later, the concierge ops queue) gets a gentle nudge
 * 7–14 days before a worrying pattern becomes obvious, rather than only
 * seeing it in hindsight on the sparkline.
 *
 * **Decline detection, not absolute-floor alerting.** The detector flags
 * a *change* (the senior was doing better and has slipped), NOT a
 * persistently-low level. A senior whose appetite is steadily `minimal`
 * isn't flagged here — that steady state is a different signal, owned by
 * the trust-safety welfare path (PDD §16.1) + a future absolute-floor
 * detector (carved as a TS-236 follow-up). Catching the *slip early* is
 * the PRD §6.9 "concerning patterns 7-14 days early" intent.
 *
 * **EWMA baseline vs recent mean.** For each scale's chronological 1..5
 * scores: the *baseline* is an exponentially-weighted moving average
 * over all but the most recent `WELLNESS_ANOMALY_RECENT_WINDOW` visits
 * (EWMA weights the visits *just before* the recent stretch most, so the
 * baseline is "the level they had settled at"); the *recent* level is the
 * simple mean of the last `WELLNESS_ANOMALY_RECENT_WINDOW` visits. The
 * `drop` is `baseline − recent` on the shared 1..5 ordinal scale. A drop
 * at or above `WELLNESS_ANOMALY_DROP_MODERATE` raises a `moderate` flag;
 * at or above `WELLNESS_ANOMALY_DROP_HIGH`, a `high` flag. Fewer than
 * `WELLNESS_ANOMALY_MIN_POINTS` recorded visits never flags — there
 * isn't enough history to tell a decline from noise.
 *
 * This heuristic is the deliberate Phase-1/2 *scaffold*. The PRD §6.9 ML
 * uplift (Phase 3 — TS-440 recommendation/anomaly engine) replaces the
 * fixed EWMA + thresholds with a learned model; the read surface + the
 * family/concierge consumers stay unchanged.
 *
 * **Same scope + consent posture as TS-231.** The service surface
 * resolves the household from the token `tenantScope` (no `householdId`
 * on the wire) and filters by household + senior; the gateway BFF
 * applies the senior's `notes` consent flag (TS-238). The family
 * response carries the `shared` flag exactly like the trends + photo
 * gallery: `shared: false` is the not-yet-shared empty state, not an
 * error.
 *
 * `.strict()` everywhere — unknown fields are a parse error (CLAUDE.md
 * §3.3).
 */

/**
 * EWMA smoothing factor for the baseline. 0.5 weights each baseline
 * visit half as much as the next-newer one — enough smoothing to ride
 * over a single off-visit while still tracking the level the senior had
 * settled at just before the recent window.
 */
export const WELLNESS_ANOMALY_EWMA_ALPHA = 0.5;

/**
 * How many of the most-recent visits constitute "now". Two (not one) so
 * a single off-day visit can't raise a flag on its own — the detector
 * looks for a *pattern* (PRD §6.9), not an outlier.
 */
export const WELLNESS_ANOMALY_RECENT_WINDOW = 2;

/**
 * Minimum recorded visits for a scale before the detector will flag.
 * `WELLNESS_ANOMALY_RECENT_WINDOW` recent + at least 2 baseline visits
 * = 4. Below this there isn't enough history to separate a decline from
 * normal visit-to-visit variation; the scale simply isn't flagged.
 */
export const WELLNESS_ANOMALY_MIN_POINTS = 4;

/**
 * Drop (baseline − recent, on the 1..5 ordinal scale) that raises a
 * `moderate` flag — roughly a full ordinal level below the established
 * baseline.
 */
export const WELLNESS_ANOMALY_DROP_MODERATE = 1.0;

/**
 * Drop that raises a `high` flag — a pronounced slide (well over a level
 * and a half) worth surfacing more prominently.
 */
export const WELLNESS_ANOMALY_DROP_HIGH = 1.75;

/** Max length of an ordinal level string (longest today is `excellent`). */
const WELLNESS_ANOMALY_LEVEL_MAX_LENGTH = 32;

/**
 * Anomaly severity tier. `high` outranks `moderate`; the family UI
 * surfaces both gently (CLAUDE.md §12 — hospitality, not clinical) but
 * can lead with the high-severity ones.
 */
export const WELLNESS_ANOMALY_SEVERITIES = ['moderate', 'high'] as const;
export const WellnessAnomalySeveritySchema = z.enum(WELLNESS_ANOMALY_SEVERITIES);
export type WellnessAnomalySeverity = z.infer<typeof WellnessAnomalySeveritySchema>;

/**
 * One flagged scale. The `drop` / `baselineScore` / `recentScore` are
 * the numeric evidence (handy for ops + the concierge queue); the
 * family UI renders warm prose from `metric` + `latestLevel`.
 */
export const WellnessAnomalyFlagSchema = z
  .object({
    metric: WellnessTrendMetricSchema,
    severity: WellnessAnomalySeveritySchema,
    /** EWMA baseline level (1..5) over the pre-recent visits. */
    baselineScore: z.number().min(WELLNESS_TREND_SCORE_MIN).max(WELLNESS_TREND_SCORE_MAX),
    /** Mean of the recent-window visits (1..5). */
    recentScore: z.number().min(WELLNESS_TREND_SCORE_MIN).max(WELLNESS_TREND_SCORE_MAX),
    /** `baselineScore − recentScore` — always ≥ the moderate threshold when present. */
    drop: z
      .number()
      .min(0)
      .max(WELLNESS_TREND_SCORE_MAX - WELLNESS_TREND_SCORE_MIN),
    /** The ordinal word of the most recent reading (for warm copy). */
    latestLevel: z.string().min(1).max(WELLNESS_ANOMALY_LEVEL_MAX_LENGTH),
    /** The most recent visit's date (the booking's scheduledStart). */
    latestVisitDate: z.string().datetime(),
    /** How many visits recorded this scale in the window (the sample size). */
    observationCount: z.number().int().min(WELLNESS_ANOMALY_MIN_POINTS),
  })
  .strict();
export type WellnessAnomalyFlag = z.infer<typeof WellnessAnomalyFlagSchema>;

/**
 * `service-booking` response for
 * `GET /api/v1/bookings/seniors/:seniorId/wellness-anomalies`.
 *
 * `flags` carries only the scales that tripped a decline (empty when all
 * is well — the common, happy case). `totalCompletedVisits` is the
 * window denominator (mirrors the trends response).
 */
export const WellnessAnomalyResponseSchema = z
  .object({
    seniorId: z.string().min(1).max(WELLNESS_TREND_SENIOR_ID_MAX_LENGTH),
    windowDays: WellnessTrendWindowDaysSchema,
    totalCompletedVisits: z.number().int().min(0),
    flags: z.array(WellnessAnomalyFlagSchema),
    generatedAt: z.string().datetime(),
  })
  .strict();
export type WellnessAnomalyResponse = z.infer<typeof WellnessAnomalyResponseSchema>;

/**
 * Gateway BFF response for
 * `GET /api/v1/seniors/:seniorId/wellness-anomalies`.
 *
 * Adds the consent `shared` flag (TS-238 `notes` surface), exactly like
 * `FamilyWellnessTrendsResponse`. When `shared` is `false` — a family
 * observer the senior hasn't granted the `notes` surface — `flags` is
 * empty and `totalCompletedVisits` is 0; nothing crosses the gateway.
 */
export const FamilyWellnessAnomalyResponseSchema = z
  .object({
    seniorId: z.string().min(1).max(WELLNESS_TREND_SENIOR_ID_MAX_LENGTH),
    shared: z.boolean(),
    windowDays: WellnessTrendWindowDaysSchema,
    totalCompletedVisits: z.number().int().min(0),
    flags: z.array(WellnessAnomalyFlagSchema),
    generatedAt: z.string().datetime(),
  })
  .strict();
export type FamilyWellnessAnomalyResponse = z.infer<typeof FamilyWellnessAnomalyResponseSchema>;

// ─────────────────────────────────────────────────────────────────────
// The detector — pure, deterministic, shared math (alongside
// `wellnessScoreForLevel`). The service-booking aggregator runs it over
// the TS-231 trend series; the TS-235 wellness-summary email can reuse
// the same function so the email and the live surface never disagree.
// ─────────────────────────────────────────────────────────────────────

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Run the decline detector over one scale's trend series.
 *
 * Returns a `WellnessAnomalyFlag` when the scale's recent mean sits at
 * or below its EWMA baseline by `WELLNESS_ANOMALY_DROP_MODERATE` or
 * more, otherwise `null` (no concern, or too few visits to judge).
 *
 * Pure + deterministic — given the same `series.points` it always
 * returns the same result, so it is fully unit-testable without a DB or
 * a clock.
 */
export function detectWellnessAnomaly(series: WellnessTrendSeries): WellnessAnomalyFlag | null {
  const points = series.points;
  const n = points.length;
  if (n < WELLNESS_ANOMALY_MIN_POINTS) return null;

  const scores = points.map((point) => point.score);
  const recentStart = n - WELLNESS_ANOMALY_RECENT_WINDOW;
  const baselineScores = scores.slice(0, recentStart);
  const recentScores = scores.slice(recentStart);

  // EWMA over the baseline visits — chronological, so the most-recent
  // baseline visit (the level just before the recent window) is weighted
  // most heavily.
  let baseline = baselineScores[0] ?? 0;
  for (let i = 1; i < baselineScores.length; i += 1) {
    const score = baselineScores[i] ?? baseline;
    baseline = WELLNESS_ANOMALY_EWMA_ALPHA * score + (1 - WELLNESS_ANOMALY_EWMA_ALPHA) * baseline;
  }

  const recent = recentScores.reduce((sum, score) => sum + score, 0) / recentScores.length;
  const drop = baseline - recent;
  if (drop < WELLNESS_ANOMALY_DROP_MODERATE) return null;

  const severity: WellnessAnomalySeverity =
    drop >= WELLNESS_ANOMALY_DROP_HIGH ? 'high' : 'moderate';
  const latest = points[n - 1];
  if (latest === undefined) return null; // defensive — n >= MIN_POINTS guarantees a last point

  return {
    metric: series.metric,
    severity,
    baselineScore: round2(baseline),
    recentScore: round2(recent),
    drop: round2(drop),
    latestLevel: latest.level,
    latestVisitDate: latest.visitDate,
    observationCount: n,
  };
}

/**
 * Convenience: run the detector over every scale's series and return the
 * flags that tripped, in the input series order (which is the fixed
 * `WELLNESS_TREND_METRICS` display order).
 */
export function detectWellnessAnomalies(
  seriesList: readonly WellnessTrendSeries[],
): WellnessAnomalyFlag[] {
  const flags: WellnessAnomalyFlag[] = [];
  for (const series of seriesList) {
    const flag = detectWellnessAnomaly(series);
    if (flag !== null) flags.push(flag);
  }
  return flags;
}

/** Re-exported for consumers that need the metric type without the trends import. */
export type { WellnessTrendMetric };
