-- TS-217-prep-3b — search-relevance mart tables.
--
-- The nightly aggregation reads the raw `search_events` /
-- `booking_created_events` landing tables (TS-217-prep-3a) for a UTC-day
-- window and writes three derived marts the TS-217 admin dashboard renders:
--
--   1. `search_relevance_daily` — ONE row per UTC day. The daily summary that
--                                 powers the zero-result RATE
--                                 (`zero_result_searches / total_searches`)
--                                 and the APPROXIMATE query→booking conversion
--                                 funnel (`bookings_created / distinct_searchers`).
--   2. `search_query_daily`      — per `(metric_date, query_text)`. Powers the
--                                 "top queries" + per-query zero-result view.
--   3. `search_sort_daily`       — per `(metric_date, sort)`. Powers the
--                                 "searches-per-sort" breakdown.
--
-- All three are DERIVED marts: the aggregation recomputes a day idempotently by
-- deleting that `metric_date`'s rows and re-inserting in one transaction. They
-- store raw COUNTS (not rates) so the dashboard re-derives ratios without a
-- stored rounding artifact. Counts are over FIRST-PAGE searches
-- (`search_events.page = 'first'`) so a deep-scroll pagination follow-up is not
-- double-counted as a new search.
--
-- Platform-wide read-side marts with NO tenant axis — search telemetry
-- aggregates across every household. Forward-compatible expand migration:
-- subsequent migrations add (never repurpose) per CLAUDE.md §4.1.
--
-- Reversal plan:
--   DROP TABLE IF EXISTS "analytics"."search_sort_daily";
--   DROP TABLE IF EXISTS "analytics"."search_query_daily";  -- drops its index too
--   DROP TABLE IF EXISTS "analytics"."search_relevance_daily";
-- Safe in isolation — no other service schema references these objects (they
-- are per-service implementation detail; cross-service refs are by id only).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-analytics prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

-- CreateTable: daily summary mart. metric_date PK = one row per UTC day.
CREATE TABLE "analytics"."search_relevance_daily" (
    "metric_date"           DATE NOT NULL,
    "total_searches"        INTEGER NOT NULL,
    "zero_result_searches"  INTEGER NOT NULL,
    "distinct_searchers"    INTEGER NOT NULL,
    "bookings_created"      INTEGER NOT NULL,
    "computed_at"           TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "search_relevance_daily_pkey" PRIMARY KEY ("metric_date")
);

-- CreateTable: per-query mart. Composite PK (metric_date, query_text).
CREATE TABLE "analytics"."search_query_daily" (
    "metric_date"        DATE NOT NULL,
    "query_text"         TEXT NOT NULL,
    "search_count"       INTEGER NOT NULL,
    "zero_result_count"  INTEGER NOT NULL,
    "computed_at"        TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "search_query_daily_pkey" PRIMARY KEY ("metric_date", "query_text")
);

-- CreateIndex: "top queries for this day, busiest first" — the dashboard's
-- dominant read (CLAUDE.md §7.3 — index every column used in a where/order at
-- scale).
CREATE INDEX "search_query_daily_date_count_idx"
    ON "analytics"."search_query_daily" ("metric_date", "search_count" DESC);

-- CreateTable: per-sort mart. Composite PK (metric_date, sort). sort is TEXT so
-- the additive-only sort enum never forces an ALTER TYPE on this read-side mart.
CREATE TABLE "analytics"."search_sort_daily" (
    "metric_date"        DATE NOT NULL,
    "sort"               TEXT NOT NULL,
    "search_count"       INTEGER NOT NULL,
    "zero_result_count"  INTEGER NOT NULL,
    "computed_at"        TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "search_sort_daily_pkey" PRIMARY KEY ("metric_date", "sort")
);
