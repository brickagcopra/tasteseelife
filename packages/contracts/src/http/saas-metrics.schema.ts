import { z } from 'zod';

import { AccountCurrencySchema } from './account.schema';

/**
 * SaaS-metrics contracts (TS-260, PRD §10.3, PDD §11.2 + §23.2).
 *
 * The nightly metrics worker computes the platform's recurring-revenue
 * metrics from accounting **ledger primitives** — specifically the
 * `accounting.deferred_revenue_balances` rows that the revenue-recognition
 * driver (TS-082) maintains. Each active balance whose service period
 * covers the metric date represents a subscription currently in a paid
 * period; its monthly-normalised value is that subscription's MRR
 * contribution. The worker persists one `saas_metrics_daily` row per
 * UTC calendar date and a per-subscription MRR snapshot used to
 * decompose period-over-period movement (new / expansion / contraction
 * / churn) on the following run.
 *
 * Two surfaces:
 *
 *   - `POST /api/v1/internal/accounting/saas-metrics/compute` —
 *     shared-secret-pinned, called by the `accounting-metrics` worker
 *     nightly. `asOf` defaults to "now" on the server.
 *
 *   - `POST /api/v1/admin/accounting/saas-metrics/compute` —
 *     `AccessTokenGuard`; ops back-fill / same-day re-run. Mirrors the
 *     `recognize-daily` admin trigger precedent (TS-082).
 *
 * **Money discipline.** Every monetary field crosses the wire as integer
 * USD minor units (cents) — CLAUDE.md §17.6, never floats. The service
 * computes in `Decimal` and rounds once at the cent; the database stores
 * `Decimal(12, 2)`.
 *
 * **Retention discipline.** Net/gross revenue-retention ratios cross the
 * wire as integer **parts-per-million** (`1.05` → `1_050_000` ppm) so the
 * float-free posture extends to ratios. The database stores
 * `Decimal(9, 6)`. Both are nullable — a snapshot with no prior
 * comparison baseline (the first-ever run, or a baseline period with zero
 * MRR) cannot define a retention ratio.
 *
 * **`ltvMinor` / `cacMinor` are nullable and null in Phase 1.** LTV needs
 * a stable churn-rate denominator and CAC needs sales/marketing-spend
 * attribution per acquired customer — neither is derivable from the
 * accounting ledger alone today. The columns ship for schema-readiness +
 * dashboard rendering; population is carved to TS-260-followup-1.
 */

/** `YYYY-MM-DD` calendar-date string (UTC). The metric-snapshot key. */
export const SAAS_METRICS_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const SaasMetricsDateSchema = z
  .string()
  .regex(SAAS_METRICS_DATE_REGEX, 'metric date must be a UTC calendar date (YYYY-MM-DD)');
export type SaasMetricsDate = z.infer<typeof SaasMetricsDateSchema>;

/**
 * Cap on any monetary field (cents). Mirrors the `Decimal(12, 2)`
 * envelope: 9,999,999,999.99 → 999,999,999,999 minor units. ARR (MRR ×
 * 12) is the field most likely to approach the ceiling at scale; the cap
 * is a wire-shape sanity bound, not a business limit.
 */
export const SAAS_METRICS_MAX_MINOR = 999_999_999_999;

/**
 * Cap on a retention ratio expressed in parts-per-million. Mirrors the
 * `Decimal(9, 6)` envelope (999.999999 → 999_999_999 ppm). A realistic
 * NRR sits near 1_000_000 (100%); the cap only rejects clearly-corrupt
 * values.
 */
export const SAAS_METRICS_MAX_RETENTION_PPM = 999_999_999;

/** One ratio unit in ppm — `1.0` (100%) === 1,000,000 ppm. */
export const SAAS_METRICS_PPM_SCALE = 1_000_000;

/**
 * Persisted daily SaaS-metrics record (PDD §8.2 `saas_metrics_daily`).
 *
 * `netNewMrrMinor` is the only monetary field that may be negative — a
 * contraction-plus-churn-heavy day nets below zero. Every other monetary
 * field is a non-negative magnitude.
 */
export const SaasMetricsRecordSchema = z
  .object({
    /** The UTC calendar date this snapshot describes. Unique key. */
    metricDate: SaasMetricsDateSchema,
    currency: AccountCurrencySchema,
    /** Monthly recurring revenue — Σ monthly-normalised active-balance MRR. */
    mrrMinor: z.number().int().min(0).max(SAAS_METRICS_MAX_MINOR),
    /** Annual recurring revenue — `mrrMinor × 12`. */
    arrMinor: z.number().int().min(0).max(SAAS_METRICS_MAX_MINOR),
    /** Average revenue per active subscription — `mrrMinor / activeSubscriptions`. */
    arpuMinor: z.number().int().min(0).max(SAAS_METRICS_MAX_MINOR),
    /** Count of distinct subscriptions with an active covering balance. */
    activeSubscriptions: z.number().int().min(0),
    /** MRR from subscriptions present today but absent in the comparison snapshot. */
    newMrrMinor: z.number().int().min(0).max(SAAS_METRICS_MAX_MINOR),
    /** Increase in MRR from subscriptions present in both snapshots that grew. */
    expansionMrrMinor: z.number().int().min(0).max(SAAS_METRICS_MAX_MINOR),
    /** Decrease in MRR from subscriptions present in both snapshots that shrank. */
    contractionMrrMinor: z.number().int().min(0).max(SAAS_METRICS_MAX_MINOR),
    /** MRR lost from subscriptions present in the comparison snapshot but gone today. */
    churnedMrrMinor: z.number().int().min(0).max(SAAS_METRICS_MAX_MINOR),
    /** Count of subscriptions present in the comparison snapshot but gone today. */
    churnedSubscriptions: z.number().int().min(0),
    /** `new + expansion − contraction − churned`. May be negative. */
    netNewMrrMinor: z.number().int().min(-SAAS_METRICS_MAX_MINOR).max(SAAS_METRICS_MAX_MINOR),
    /** MRR in the comparison snapshot (the retention baseline). */
    priorMrrMinor: z.number().int().min(0).max(SAAS_METRICS_MAX_MINOR),
    /**
     * Net revenue retention in ppm: `(prior + expansion − contraction −
     * churned) / prior`. Null when there is no prior baseline or prior MRR
     * is zero.
     */
    netRevenueRetentionPpm: z.number().int().min(0).max(SAAS_METRICS_MAX_RETENTION_PPM).nullable(),
    /**
     * Gross revenue retention in ppm: `(prior − contraction − churned) /
     * prior`. Null when there is no prior baseline or prior MRR is zero.
     */
    grossRevenueRetentionPpm: z
      .number()
      .int()
      .min(0)
      .max(SAAS_METRICS_MAX_RETENTION_PPM)
      .nullable(),
    /** Lifetime value (cents). Null in Phase 1 — TS-260-followup-1. */
    ltvMinor: z.number().int().min(0).max(SAAS_METRICS_MAX_MINOR).nullable(),
    /** Customer-acquisition cost (cents). Null in Phase 1 — TS-260-followup-1. */
    cacMinor: z.number().int().min(0).max(SAAS_METRICS_MAX_MINOR).nullable(),
    /** The prior snapshot date the movement was decomposed against. Null on first run. */
    comparisonDate: SaasMetricsDateSchema.nullable(),
    /** When the worker computed this snapshot (ISO-8601). */
    computedAt: z.string().datetime(),
  })
  .strict();
export type SaasMetricsRecord = z.infer<typeof SaasMetricsRecordSchema>;

/**
 * Request body for both compute endpoints.
 *
 * `asOf` defaults to "now" on the server. Supplied for ops back-fills /
 * deterministic test runs (e.g. recompute 2026-05-15 after a missed
 * nightly tick). The metric snapshot is keyed by the UTC calendar date of
 * `asOf`; re-running for the same date replaces the prior computation
 * idempotently.
 */
export const ComputeSaasMetricsRequestSchema = z
  .object({
    asOf: z.string().datetime().optional(),
  })
  .strict();
export type ComputeSaasMetricsRequest = z.infer<typeof ComputeSaasMetricsRequestSchema>;

/**
 * Response shape for both compute endpoints. Returns the computed record
 * plus the per-subscription snapshot row count for observability (so the
 * worker can log "snapshotted N subscriptions" without a second read).
 */
export const ComputeSaasMetricsResponseSchema = z
  .object({
    metrics: SaasMetricsRecordSchema,
    subscriptionsSnapshotted: z.number().int().min(0),
  })
  .strict();
export type ComputeSaasMetricsResponse = z.infer<typeof ComputeSaasMetricsResponseSchema>;

/**
 * Cap on the number of daily snapshots a single range read returns
 * (~13 months of daily rows). The admin dashboard's date-range read
 * (TS-266) scans the `saas_metrics_daily.metric_date` unique b-tree
 * backwards and takes at most this many rows; a wider range silently
 * truncates to the most recent `SAAS_METRICS_RANGE_MAX_ROWS` snapshots
 * (the response echoes the EFFECTIVE `from`/`to` so the UI shows the real
 * window). Bounds the scan + the wire payload (CLAUDE.md §7.2).
 */
export const SAAS_METRICS_RANGE_MAX_ROWS = 400;

/**
 * Query for the admin dashboard date-range read (TS-266):
 * `GET /api/v1/admin/accounting/saas-metrics`. Both bounds are optional +
 * inclusive; an absent `from`/`to` is unbounded on that side (the service
 * still caps the row count at `SAAS_METRICS_RANGE_MAX_ROWS`, most-recent
 * first). `from` must not be after `to` when both are supplied —
 * lexical `YYYY-MM-DD` comparison is date-correct.
 */
export const SaasMetricsRangeQuerySchema = z
  .object({
    from: SaasMetricsDateSchema.optional(),
    to: SaasMetricsDateSchema.optional(),
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
export type SaasMetricsRangeQuery = z.infer<typeof SaasMetricsRangeQuerySchema>;

/**
 * Response for the admin dashboard date-range read (TS-266): the daily
 * snapshots in ascending `metricDate` order (oldest first, ready to plot
 * left-to-right) plus the resolved window bounds. `from`/`to` echo the
 * EFFECTIVE window — the earliest + latest `metricDate` actually returned
 * — so the UI renders the real span even when the request omitted a bound
 * or the row cap truncated it. Both null when no snapshots fall in range.
 */
export const ListSaasMetricsResponseSchema = z
  .object({
    metrics: z.array(SaasMetricsRecordSchema),
    from: SaasMetricsDateSchema.nullable(),
    to: SaasMetricsDateSchema.nullable(),
  })
  .strict();
export type ListSaasMetricsResponse = z.infer<typeof ListSaasMetricsResponseSchema>;
