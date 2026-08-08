import { z } from 'zod';

import { BOOKING_SOFT_FK_MAX_LENGTH } from './booking.schema';
import {
  VisitNoteAppetiteSchema,
  VisitNoteHydrationSchema,
  VisitNoteMoodSchema,
  VisitNoteSocialEngagementSchema,
} from './booking-visit-notes.schema';

/**
 * Wellness-trend read DTOs (TS-231; PRD §6.4, §6.9; PDD §23.1).
 *
 * The family peace-of-mind dashboard surfaces a senior's recent visits
 * as discrete chips (TS-230). TS-231 adds the *over time* view: for one
 * senior, the last 30 / 90 days of completed-visit wellness observations
 * plotted as a sparkline per scale, so an adult child sees the shape of
 * "how has mom been lately" at a glance.
 *
 * **Per-visit data points (not bucketed averages).** Each completed
 * visit that recorded a given scale contributes one point to that
 * scale's series, in visit-date order. We deliberately do NOT bucket /
 * average: the scales are coarse 5-point ordinals (CLAUDE.md §12 —
 * hospitality, not clinical), and averaging an ordinal invents a
 * precision the data doesn't carry and hides how few visits a line is
 * drawn from. Each metric's series only includes visits where *that*
 * scale was recorded — a visit where the provider logged appetite but
 * not mood appears in the appetite series alone.
 *
 * **Four scales, not five.** The TS-231 title lists "mobility" but the
 * `booking_visit_notes` row (TS-062) captures only mood / appetite /
 * hydration / social_engagement. A per-visit mobility observation is a
 * separate TS-062 schema extension, not part of this aggregation.
 *
 * **Ordinal → score.** Each scale's five levels map to an integer 1..5
 * by their position in the (already low→high ordered) enum. `score` is
 * the y-value the sparkline plots; `level` is the ordinal string so the
 * consumer can render a warm label without re-deriving the mapping.
 * `wellnessScoreForLevel` is the single source of that mapping, shared
 * by the service-side aggregator and the web-family renderer.
 *
 * **Household resolution + consent.** No `householdId` crosses the wire
 * — `service-booking` resolves it from the token `tenantScope` (the
 * `/me` pattern) and filters bookings by household + senior, so a
 * foreign senior id yields empty series rather than a cross-household
 * leak. The gateway BFF additionally applies the senior's `notes`
 * consent flag (TS-238): the primary payer + the senior see
 * unconditionally; a `family_observer` sees the trends only when the
 * senior has shared the `notes` surface (default opt-out). The family
 * response carries a `shared` flag exactly like the TS-232 photo
 * gallery — `shared: false` is the empty, not-yet-shared state, not an
 * error.
 *
 * `.strict()` everywhere — unknown fields are a parse error so a typo
 * or stray client field never silently round-trips (CLAUDE.md §3.3).
 */

/**
 * The two windows the trend view offers. Distinct from the dashboard's
 * 7 / 30 / 90 (TS-230) — a 7-day window rarely holds enough completed
 * visits to draw a meaningful line, so the trend surface starts at 30.
 */
export const WELLNESS_TREND_WINDOW_DAYS_VALUES = [30, 90] as const;
export type WellnessTrendWindowDays = (typeof WELLNESS_TREND_WINDOW_DAYS_VALUES)[number];
export const WELLNESS_TREND_WINDOW_DAYS_DEFAULT: WellnessTrendWindowDays = 30;

/** Literal-union schema for the response `windowDays` echo. */
export const WellnessTrendWindowDaysSchema = z.union([z.literal(30), z.literal(90)]);

/**
 * The four wellness scales the trend view plots, in the fixed display
 * order the family response always returns them in. Snake-case wire
 * values mirror the booking domain's other multi-word enums (e.g.
 * `social_outing`). `social_engagement` maps to the `socialEngagement`
 * field on a `booking_visit_notes` row.
 */
export const WELLNESS_TREND_METRICS = [
  'mood',
  'appetite',
  'hydration',
  'social_engagement',
] as const;
export const WellnessTrendMetricSchema = z.enum(WELLNESS_TREND_METRICS);
export type WellnessTrendMetric = z.infer<typeof WellnessTrendMetricSchema>;

/** Score range — every scale is a 5-point ordinal. */
export const WELLNESS_TREND_SCORE_MIN = 1;
export const WELLNESS_TREND_SCORE_MAX = 5;

/**
 * Hard cap on the number of completed visits scanned into the series
 * per window — a defence against a pathological household (e.g. daily
 * concierge visits over 90 days) blowing the payload. The aggregator
 * keeps the most-recent `WELLNESS_TREND_MAX_VISITS`; the response's
 * `totalCompletedVisits` reports the true count so the consumer can
 * note when the line is truncated. 200 comfortably exceeds a realistic
 * 90-day cadence (weekly ≈ 13, even daily ≈ 90).
 */
export const WELLNESS_TREND_MAX_VISITS = 200;

/** Soft-FK length cap, shared with the booking domain. */
export const WELLNESS_TREND_SENIOR_ID_MAX_LENGTH = BOOKING_SOFT_FK_MAX_LENGTH;

/** Max length of an ordinal level string (longest today is `excellent`). */
const WELLNESS_TREND_LEVEL_MAX_LENGTH = 32;

/**
 * The low→high ordered levels per scale. Reuses the visit-note enum
 * options directly so the order can never drift from the source enum.
 */
const ORDERED_LEVELS_BY_METRIC: Record<WellnessTrendMetric, readonly string[]> = {
  mood: VisitNoteMoodSchema.options,
  appetite: VisitNoteAppetiteSchema.options,
  hydration: VisitNoteHydrationSchema.options,
  social_engagement: VisitNoteSocialEngagementSchema.options,
};

/**
 * Map an ordinal level to its 1..5 score (its 1-based position in the
 * scale's ordered levels), or `null` if the level is not a member of
 * the scale. The single source of the ordinal→numeric mapping, shared
 * by `service-booking`'s aggregator and the web-family renderer so the
 * sparkline and any future server-side trend math agree.
 */
export function wellnessScoreForLevel(metric: WellnessTrendMetric, level: string): number | null {
  const index = ORDERED_LEVELS_BY_METRIC[metric].indexOf(level);
  return index === -1 ? null : index + 1;
}

/** The ordered levels for a scale — exported for the renderer's y-axis labels. */
export function wellnessLevelsForMetric(metric: WellnessTrendMetric): readonly string[] {
  return ORDERED_LEVELS_BY_METRIC[metric];
}

/**
 * One completed visit's observation of a single scale.
 *
 * `visitDate` is the booking's `scheduledStart` (when the visit
 * happened — the x-axis), `recordedAt` is when the provider wrote the
 * note (kept for reference, usually near the visit).
 */
export const WellnessTrendPointSchema = z
  .object({
    bookingId: z.string().min(1).max(WELLNESS_TREND_SENIOR_ID_MAX_LENGTH),
    visitDate: z.string().datetime(),
    recordedAt: z.string().datetime(),
    level: z.string().min(1).max(WELLNESS_TREND_LEVEL_MAX_LENGTH),
    score: z.number().int().min(WELLNESS_TREND_SCORE_MIN).max(WELLNESS_TREND_SCORE_MAX),
  })
  .strict();
export type WellnessTrendPoint = z.infer<typeof WellnessTrendPointSchema>;

/**
 * One scale's trend line — its points in chronological (oldest-first)
 * order, the most-recent score for the headline reading, and how many
 * visits recorded this scale (the line's sample size).
 */
export const WellnessTrendSeriesSchema = z
  .object({
    metric: WellnessTrendMetricSchema,
    points: z.array(WellnessTrendPointSchema),
    latestScore: z
      .number()
      .int()
      .min(WELLNESS_TREND_SCORE_MIN)
      .max(WELLNESS_TREND_SCORE_MAX)
      .nullable(),
    visitsRecorded: z.number().int().min(0),
  })
  .strict();
export type WellnessTrendSeries = z.infer<typeof WellnessTrendSeriesSchema>;

/**
 * Query for the `service-booking` aggregate read
 * (`GET /api/v1/bookings/seniors/:seniorId/wellness-trends`) and the
 * gateway BFF (`GET /api/v1/seniors/:seniorId/wellness-trends`).
 *
 * `windowDays` coerces from the query string and must be one of the two
 * offered windows (defaults to 30). The senior id rides in the path,
 * not here.
 */
export const WellnessTrendsQuerySchema = z
  .object({
    windowDays: z.coerce
      .number()
      .int()
      .refine(
        (value): value is WellnessTrendWindowDays =>
          (WELLNESS_TREND_WINDOW_DAYS_VALUES as readonly number[]).includes(value),
        { message: 'windowDays must be one of 30 or 90' },
      )
      .default(WELLNESS_TREND_WINDOW_DAYS_DEFAULT),
  })
  .strict();
export type WellnessTrendsQuery = z.infer<typeof WellnessTrendsQuerySchema>;

/**
 * `service-booking` response for
 * `GET /api/v1/bookings/seniors/:seniorId/wellness-trends`.
 *
 * `series` always carries all four scales in `WELLNESS_TREND_METRICS`
 * order (a scale with no recorded visits has an empty `points` array +
 * `latestScore: null` rather than being absent — the consumer can show
 * a "not recorded yet" state per scale). `totalCompletedVisits` is the
 * true count of completed visits in the window (the denominator;
 * exceeds the points-per-series when a visit recorded only some scales,
 * or when the count exceeds `WELLNESS_TREND_MAX_VISITS`).
 */
export const WellnessTrendsResponseSchema = z
  .object({
    seniorId: z.string().min(1).max(WELLNESS_TREND_SENIOR_ID_MAX_LENGTH),
    windowDays: WellnessTrendWindowDaysSchema,
    totalCompletedVisits: z.number().int().min(0),
    series: z.array(WellnessTrendSeriesSchema),
    generatedAt: z.string().datetime(),
  })
  .strict();
export type WellnessTrendsResponse = z.infer<typeof WellnessTrendsResponseSchema>;

/**
 * Gateway BFF response for
 * `GET /api/v1/seniors/:seniorId/wellness-trends`.
 *
 * Adds the consent `shared` flag (mirroring the TS-232
 * `FamilySeniorPhotoGalleryResponse`). When `shared` is `false` — a
 * family observer the senior hasn't granted the `notes` surface — the
 * series are empty and `totalCompletedVisits` is 0; the trends never
 * cross the gateway. `shared: true` carries the real aggregate.
 */
export const FamilyWellnessTrendsResponseSchema = z
  .object({
    seniorId: z.string().min(1).max(WELLNESS_TREND_SENIOR_ID_MAX_LENGTH),
    shared: z.boolean(),
    windowDays: WellnessTrendWindowDaysSchema,
    totalCompletedVisits: z.number().int().min(0),
    series: z.array(WellnessTrendSeriesSchema),
    generatedAt: z.string().datetime(),
  })
  .strict();
export type FamilyWellnessTrendsResponse = z.infer<typeof FamilyWellnessTrendsResponseSchema>;
