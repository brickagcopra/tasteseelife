import { z } from 'zod';

/**
 * Search-relevance metrics contracts (TS-217-prep-3b; PRD §10.1, PDD §23.1
 * + §23.2).
 *
 * The nightly analytics-aggregator worker triggers `service-analytics` to
 * read the raw `analytics.search_events` (+ `analytics.booking_created_events`)
 * landing tables (TS-217-prep-3a) for a single UTC calendar-day window and
 * compute the search-relevance marts the TS-217 admin dashboard renders:
 *
 *   - **top queries** — `analytics.search_query_daily` (per query text).
 *   - **zero-result queries / rate** — `zeroResultSearches / totalSearches`,
 *     plus the per-query / per-sort zero counts on the detail marts.
 *   - **searches-per-sort** — `analytics.search_sort_daily` (per sort).
 *   - **query→booking conversion** — TWO funnels: a PRECISE per-search
 *     attribution (`attributedBookings / totalSearches`, TS-217-prep-4c-followup-1)
 *     and the retained APPROXIMATE daily funnel
 *     (`bookingsCreated / distinctSearchers`). See the conversion caveat
 *     below.
 *
 * Two surfaces (mirroring the SaaS-metrics compute precedent, TS-260):
 *
 *   - `POST /api/v1/internal/analytics/search-relevance/compute` —
 *     shared-secret-pinned, called by the `analytics-aggregator` worker
 *     nightly. The worker passes an `asOf` inside the PREVIOUS complete UTC
 *     day so a full 24h window is aggregated (unlike the SaaS-metrics
 *     snapshot, which is a point-in-time read of "now").
 *   - `POST /api/v1/admin/analytics/search-relevance/compute` —
 *     `AccessTokenGuard`; ops back-fill / same-day re-run.
 *
 * **Aggregation grain.** All search aggregations count only first-page
 * searches (`search_events.page = 'first'`) so a deep-scroll pagination
 * follow-up is not double-counted as a new search — matching the
 * `SearchPagePositionSchema` contract note. A zero-result search has no
 * pages to scroll (`totalEstimate = 0`), so it is always a first page;
 * filtering to `first` therefore loses no zero-result signal.
 *
 * **Conversion (precise + approximate).** `booking.created` now echoes the
 * originating search's correlation token (`searchId`, TS-217-prep-4a/4c),
 * captured on `analytics.booking_created_events.search_id`. The PRECISE
 * `attributedConversionPpm` counts bookings whose `search_id` joins a
 * same-window `search_events.event_id` (the per-search attribution numerator,
 * `attributedBookings`) over `totalSearches` (TS-217-prep-4c-followup-1). The
 * approximate funnel is RETAINED for continuity + as a coverage cross-check:
 * `approxConversionPpm` is the COARSE platform-wide daily ratio
 * (`bookingsCreated / distinctSearchers`) — useful before search-token
 * coverage is complete, since a booking that did not arrive from a search
 * (concierge manual booking, direct-link visit) carries no `search_id` and so
 * never contributes to `attributedBookings`.
 *
 * **Numerator grain caveat.** `attributedBookings` joins on ANY same-window
 * `search_events.event_id` (first OR paged page), while `totalSearches` is the
 * FIRST-PAGE distinct-search grain. At Phase-1 scale pagination is rare so the
 * mismatch is negligible; the rate stays a faithful per-search conversion and
 * the dashboard guards a zero denominator the same way the other rates do.
 *
 * **Ratio discipline.** Rates cross the wire as integer parts-per-million
 * (`0.05` → `50_000` ppm) so the response stays float-free, matching the
 * SaaS-metrics retention-ppm convention. Both rate fields are nullable —
 * a day with zero searches (or zero distinct searchers) cannot define a
 * rate. The durable marts store raw COUNTS, not rates; the ppm fields are a
 * computed convenience on the compute response for worker logging + tests.
 */

/** `YYYY-MM-DD` calendar-date string (UTC). The mart-window key. */
export const SEARCH_RELEVANCE_METRICS_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const SearchRelevanceMetricsDateSchema = z
  .string()
  .regex(
    SEARCH_RELEVANCE_METRICS_DATE_REGEX,
    'metric date must be a UTC calendar date (YYYY-MM-DD)',
  );
export type SearchRelevanceMetricsDate = z.infer<typeof SearchRelevanceMetricsDateSchema>;

/** One ratio unit in ppm — `1.0` (100%) === 1,000,000 ppm. */
export const SEARCH_RELEVANCE_PPM_SCALE = 1_000_000;

/**
 * Cap on a rate expressed in parts-per-million. Both the zero-result rate
 * and the approximate conversion rate are bounded magnitudes — the
 * zero-result rate is in `[0, 1]` (≤ 1_000_000 ppm), and the approximate
 * conversion rate can exceed 1.0 (a household may book more than once per
 * searcher) but a value past ~100× is clearly corrupt. The cap only rejects
 * obviously-bad values; it is a wire-shape sanity bound, not a business
 * limit.
 */
export const SEARCH_RELEVANCE_MAX_RATE_PPM = 100 * SEARCH_RELEVANCE_PPM_SCALE;

/**
 * Request body for both compute endpoints.
 *
 * `asOf` defaults to "now" on the server. Supplied for ops back-fills /
 * deterministic test runs. The marts are keyed by the UTC calendar date of
 * `asOf`; re-running for the same date replaces that date's mart rows
 * idempotently (delete-and-reinsert in one transaction). The worker always
 * supplies `asOf` (an instant inside the previous complete UTC day).
 */
export const ComputeSearchRelevanceMetricsRequestSchema = z
  .object({
    asOf: z.string().datetime().optional(),
  })
  .strict();
export type ComputeSearchRelevanceMetricsRequest = z.infer<
  typeof ComputeSearchRelevanceMetricsRequestSchema
>;

/**
 * Response shape for both compute endpoints. Returns the daily summary
 * primitives (raw counts) plus the two computed rate ppm fields and the
 * `analytics_aggregation_runs` row id stamped for the run — enough for the
 * worker to log the outcome without a second read.
 */
export const ComputeSearchRelevanceMetricsResponseSchema = z
  .object({
    /** The UTC calendar date this aggregation window covers. */
    metricDate: SearchRelevanceMetricsDateSchema,
    /** First-page searches in the window (the distinct-search grain). */
    totalSearches: z.number().int().min(0),
    /** First-page searches that returned nothing (`zero_results = true`). */
    zeroResultSearches: z.number().int().min(0),
    /** Distinct `actorUserId`s who ran a first-page search in the window. */
    distinctSearchers: z.number().int().min(0),
    /** `booking.created` events in the window (the approximate numerator). */
    bookingsCreated: z.number().int().min(0),
    /**
     * Bookings whose `search_id` joins a same-window `search_events.event_id`
     * (the PRECISE per-search attribution numerator, TS-217-prep-4c-followup-1).
     * A subset of `bookingsCreated` — only bookings that arrived from a search
     * carry a token, so `attributedBookings <= bookingsCreated`.
     */
    attributedBookings: z.number().int().min(0),
    /** Distinct non-null query-text rows written to `search_query_daily`. */
    topQueryCount: z.number().int().min(0),
    /** Distinct sort rows written to `search_sort_daily`. */
    sortBucketCount: z.number().int().min(0),
    /**
     * `zeroResultSearches / totalSearches` in ppm. Null when `totalSearches`
     * is zero (no searches → no rate to define).
     */
    zeroResultRatePpm: z.number().int().min(0).max(SEARCH_RELEVANCE_MAX_RATE_PPM).nullable(),
    /**
     * APPROXIMATE conversion: `bookingsCreated / distinctSearchers` in ppm.
     * A coarse platform-wide daily funnel, NOT a per-search attribution —
     * see the conversion caveat in the file header. Null when
     * `distinctSearchers` is zero.
     */
    approxConversionPpm: z.number().int().min(0).max(SEARCH_RELEVANCE_MAX_RATE_PPM).nullable(),
    /**
     * PRECISE per-search conversion: `attributedBookings / totalSearches` in
     * ppm (TS-217-prep-4c-followup-1). Null when `totalSearches` is zero (no
     * searches → no rate to define).
     */
    attributedConversionPpm: z.number().int().min(0).max(SEARCH_RELEVANCE_MAX_RATE_PPM).nullable(),
    /** The `analytics_aggregation_runs.id` stamped for this run. */
    runId: z.string().min(1),
    /** When the worker/service computed this window (ISO-8601). */
    computedAt: z.string().datetime(),
  })
  .strict();
export type ComputeSearchRelevanceMetricsResponse = z.infer<
  typeof ComputeSearchRelevanceMetricsResponseSchema
>;

/* -------------------------------------------------------------------------- *
 * Dashboard READ surface (TS-217a; PRD §10.1, PDD §23.1/§23.2).
 *
 * The compute surfaces above (prep-3b) WRITE the marts; these read shapes
 * back the web-admin search-relevance dashboard (TS-217b). Two reads,
 * mirroring the SaaS-metrics dashboard read (TS-266):
 *
 *   - `GET /api/v1/admin/analytics/search-relevance/summary?from=&to=` —
 *     the per-day summary series (`search_relevance_daily`) with the derived
 *     rate ppm fields, for the trend chart + headline KPIs.
 *   - `GET /api/v1/admin/analytics/search-relevance/detail?date=` — a single
 *     UTC day's drill-down: top queries + zero-result queries
 *     (`search_query_daily`), searches-per-sort (`search_sort_daily`), and
 *     CTR-by-position (`search_click_position_daily`).
 *
 * Both behind `AccessTokenGuard` + `SuperAdminRoleGuard`. Read-only — no
 * `@Idempotent()`. The marts store raw COUNTS; the rate ppm fields are
 * re-derived on read with the same `rateToPpm` helper the compute path uses,
 * so the compute + read surfaces agree exactly (no stored rounding artifact).
 * -------------------------------------------------------------------------- */

/**
 * One day's search-relevance summary (the `search_relevance_daily` mart row)
 * as the dashboard wire shape: the durable counts plus the three derived
 * rate ppm fields. The ppm fields are nullable on the same conditions as the
 * compute response — a day with zero searches (or zero distinct searchers)
 * cannot define the corresponding rate.
 */
export const SearchRelevanceDailySummarySchema = z
  .object({
    /** The UTC calendar date this summary covers. Unique key. */
    metricDate: SearchRelevanceMetricsDateSchema,
    /** First-page searches in the window (the distinct-search grain). */
    totalSearches: z.number().int().min(0),
    /** First-page searches that returned nothing (`zero_results = true`). */
    zeroResultSearches: z.number().int().min(0),
    /** Distinct `actorUserId`s who ran a first-page search in the window. */
    distinctSearchers: z.number().int().min(0),
    /** `booking.created` events in the window (the approximate numerator). */
    bookingsCreated: z.number().int().min(0),
    /** Bookings whose `search_id` joins a same-window search (precise numerator). */
    attributedBookings: z.number().int().min(0),
    /** `zeroResultSearches / totalSearches` in ppm. Null when no searches. */
    zeroResultRatePpm: z.number().int().min(0).max(SEARCH_RELEVANCE_MAX_RATE_PPM).nullable(),
    /** APPROXIMATE conversion `bookingsCreated / distinctSearchers` in ppm. Null when no searchers. */
    approxConversionPpm: z.number().int().min(0).max(SEARCH_RELEVANCE_MAX_RATE_PPM).nullable(),
    /** PRECISE conversion `attributedBookings / totalSearches` in ppm. Null when no searches. */
    attributedConversionPpm: z.number().int().min(0).max(SEARCH_RELEVANCE_MAX_RATE_PPM).nullable(),
    /** When the nightly aggregation last (re)computed this row (ISO-8601). */
    computedAt: z.string().datetime(),
  })
  .strict();
export type SearchRelevanceDailySummary = z.infer<typeof SearchRelevanceDailySummarySchema>;

/**
 * Cap on the number of daily summary rows a single range read returns
 * (~13 months of daily rows). The dashboard's date-range read scans the
 * `search_relevance_daily.metric_date` PK b-tree backwards and takes at most
 * this many rows; a wider range silently truncates to the most recent N days
 * (the response echoes the EFFECTIVE `from`/`to`). Bounds the scan + payload
 * (CLAUDE.md §7.2). Mirrors `SAAS_METRICS_RANGE_MAX_ROWS`.
 */
export const SEARCH_RELEVANCE_RANGE_MAX_ROWS = 400;

/**
 * Query for the daily-summary range read
 * (`GET /api/v1/admin/analytics/search-relevance/summary`). Both bounds
 * optional + inclusive; an absent bound is unbounded on that side (the service
 * still caps the row count, most-recent first). `from` must not be after `to`
 * when both supplied — lexical `YYYY-MM-DD` comparison is date-correct.
 */
export const SearchRelevanceRangeQuerySchema = z
  .object({
    from: SearchRelevanceMetricsDateSchema.optional(),
    to: SearchRelevanceMetricsDateSchema.optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'from must not be after to',
      });
    }
  });
export type SearchRelevanceRangeQuery = z.infer<typeof SearchRelevanceRangeQuerySchema>;

/**
 * Response for the daily-summary range read: the per-day summaries in
 * ascending `metricDate` order (oldest first, ready to plot left-to-right)
 * plus the resolved window bounds. `from`/`to` echo the EFFECTIVE window —
 * the earliest + latest `metricDate` actually returned — so the UI renders
 * the real span even when a bound was omitted or the cap truncated it. Both
 * null when no rows fall in range.
 */
export const ListSearchRelevanceDailyResponseSchema = z
  .object({
    summaries: z.array(SearchRelevanceDailySummarySchema),
    from: SearchRelevanceMetricsDateSchema.nullable(),
    to: SearchRelevanceMetricsDateSchema.nullable(),
  })
  .strict();
export type ListSearchRelevanceDailyResponse = z.infer<
  typeof ListSearchRelevanceDailyResponseSchema
>;

/**
 * Cap on each detail list (top queries, zero-result queries, sort buckets,
 * click positions) a single day-detail read returns. The dashboard's
 * drill-down only needs the busiest rows; a longer tail truncates. Bounds the
 * scan + payload (CLAUDE.md §7.2).
 */
export const SEARCH_RELEVANCE_DETAIL_MAX_ROWS = 100;

/** Query for the single-day detail read (`?date=YYYY-MM-DD`). */
export const SearchRelevanceDetailQuerySchema = z
  .object({
    date: SearchRelevanceMetricsDateSchema,
  })
  .strict();
export type SearchRelevanceDetailQuery = z.infer<typeof SearchRelevanceDetailQuerySchema>;

/** One per-query detail row (`search_query_daily`). */
export const SearchRelevanceQueryStatSchema = z
  .object({
    /** Verbatim free-text query (provider-discovery text, not senior PII). */
    queryText: z.string().min(1).max(256),
    /** First-page searches with this query text in the day. */
    searchCount: z.number().int().min(0),
    /** Of those, how many returned nothing. */
    zeroResultCount: z.number().int().min(0),
  })
  .strict();
export type SearchRelevanceQueryStat = z.infer<typeof SearchRelevanceQueryStatSchema>;

/** One per-sort detail row (`search_sort_daily`). */
export const SearchRelevanceSortStatSchema = z
  .object({
    /** Sort the user chose (`relevance` | `rating` | `distance` — TEXT mirror). */
    sort: z.string().min(1),
    /** First-page searches using this sort in the day. */
    searchCount: z.number().int().min(0),
    /** Of those, how many returned nothing. */
    zeroResultCount: z.number().int().min(0),
  })
  .strict();
export type SearchRelevanceSortStat = z.infer<typeof SearchRelevanceSortStatSchema>;

/** One per-position CTR detail row (`search_click_position_daily`). */
export const SearchRelevanceClickPositionStatSchema = z
  .object({
    /** Zero-based result position (rank within the page the user saw). */
    position: z.number().int().min(0),
    /** Clicks on this position in the day (the CTR numerator). */
    clickCount: z.number().int().min(0),
    /** First-page searches that rendered this position (the CTR denominator). */
    impressionCount: z.number().int().min(0),
    /**
     * Click-through rate `clickCount / impressionCount` in ppm. Null when the
     * impression denominator is zero (e.g. a click whose originating search
     * fell on a previous day, so no same-day first-page impression backs it).
     */
    ctrPpm: z.number().int().min(0).max(SEARCH_RELEVANCE_MAX_RATE_PPM).nullable(),
  })
  .strict();
export type SearchRelevanceClickPositionStat = z.infer<
  typeof SearchRelevanceClickPositionStatSchema
>;

/**
 * Response for the single-day detail read. `summary` is the day's
 * `search_relevance_daily` row (null when the day was never aggregated).
 * The four lists are each capped at `SEARCH_RELEVANCE_DETAIL_MAX_ROWS` and
 * pre-sorted for the dashboard: `topQueries` busiest-first, `zeroResultQueries`
 * highest-zero-count-first (only queries with ≥1 zero-result row), `sortBreakdown`
 * busiest-first, `clickPositions` by ascending position.
 */
export const SearchRelevanceDayDetailResponseSchema = z
  .object({
    metricDate: SearchRelevanceMetricsDateSchema,
    summary: SearchRelevanceDailySummarySchema.nullable(),
    topQueries: z.array(SearchRelevanceQueryStatSchema),
    zeroResultQueries: z.array(SearchRelevanceQueryStatSchema),
    sortBreakdown: z.array(SearchRelevanceSortStatSchema),
    clickPositions: z.array(SearchRelevanceClickPositionStatSchema),
  })
  .strict();
export type SearchRelevanceDayDetailResponse = z.infer<
  typeof SearchRelevanceDayDetailResponseSchema
>;
