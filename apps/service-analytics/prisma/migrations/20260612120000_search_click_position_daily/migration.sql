-- TS-217-prep-4b-followup-1 — CTR-by-position aggregation mart.
--
-- The nightly aggregation (folded into the existing `search-relevance-daily`
-- run + transaction, TS-217-prep-3b) reads the raw `search_click_events`
-- landing table (TS-217-prep-4b) for a UTC-day window and writes one derived
-- mart the TS-217 admin dashboard renders:
--
--   `search_click_position_daily` — per `(metric_date, position)`. Powers the
--                                    "CTR by result position" panel.
--
-- Each row carries:
--   * `click_count`      — clicks on this position that day (the CTR numerator),
--                          from `search_click_events`.
--   * `impression_count` — first-page searches that rendered this position (the
--                          CTR denominator). A first-page search returning `r`
--                          hits showed positions `0 .. r-1`, so position `p` is
--                          an impression when `result_count > p` — derived from
--                          the existing `search_events` table, no new raw
--                          capture required.
--
-- Only positions that received at least one click that day land here (mirroring
-- `search_query_daily` / `search_sort_daily`, which only emit rows for query
-- texts / sorts that occurred). The dashboard derives CTR = `click_count /
-- impression_count`, guarding a zero denominator (an undefined CTR). Raw COUNTS
-- are stored (not the rate) so the UI re-derives ratios without a stored
-- rounding artifact.
--
-- DERIVED mart: the aggregation recomputes a day idempotently by deleting that
-- `metric_date`'s rows and re-inserting in the same transaction as the prep-3b
-- marts. Platform-wide read-side mart with NO tenant axis — click telemetry
-- aggregates across every household. Forward-compatible expand migration:
-- subsequent migrations add (never repurpose) per CLAUDE.md §4.1.
--
-- Reversal plan:
--   DROP TABLE IF EXISTS "analytics"."search_click_position_daily";  -- drops its index too
-- Safe in isolation — no other service schema references this object (it is a
-- per-service implementation detail; cross-service refs are by id only).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-analytics prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

-- CreateTable: per-position CTR mart. Composite PK (metric_date, position).
CREATE TABLE "analytics"."search_click_position_daily" (
    "metric_date"       DATE NOT NULL,
    "position"          INTEGER NOT NULL,
    "click_count"       INTEGER NOT NULL,
    "impression_count"  INTEGER NOT NULL,
    "computed_at"       TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "search_click_position_daily_pkey" PRIMARY KEY ("metric_date", "position")
);

-- CreateIndex: "most-clicked positions for this day, busiest first" — the
-- dashboard's dominant read (CLAUDE.md §7.3 — index every column used in a
-- where/order at scale).
CREATE INDEX "search_click_position_daily_date_clicks_idx"
    ON "analytics"."search_click_position_daily" ("metric_date", "click_count" DESC);
