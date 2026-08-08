-- TS-217-prep-3a — outbox-consumer dedup table + raw-event landing tables.
--
-- service-analytics becomes an outbox CONSUMER of `search.performed`
-- (TS-217-prep-1) + `booking.created` via the
-- `@taste-and-see/nest-outbox-consumer` SDK. This migration adds three tables
-- to the `analytics` schema:
--
--   1. `outbox_consumer_dedup`     — the canonical SDK dedup table (the
--                                    SECONDARY line of defence against
--                                    redelivery). Shape mirrors the
--                                    `PgConsumerDedupStore` doc-comment +
--                                    service-accounting's identical table.
--   2. `search_events`             — raw `search.performed` landing table
--                                    (PRIMARY idempotency via the `event_id`
--                                    PK). The interim Postgres store for the
--                                    Cassandra `analytics.events` keyspace
--                                    (PDD §8.3 / TS-217-prep-3a-followup-1).
--   3. `booking_created_events`    — raw `booking.created` landing table
--                                    (same idempotency shape).
--
-- The prep-3b nightly aggregation reads `search_events` /
-- `booking_created_events` by `occurred_at` window to compute the TS-217
-- search-relevance marts. Forward-compatible expand migration: subsequent
-- migrations add (never repurpose) per CLAUDE.md §4.1.
--
-- Cross-service references are by id only (CLAUDE.md §2.3): the `*_id` columns
-- on `booking_created_events` are soft FKs into service-booking /
-- service-household / service-provider — never a declared foreign key into
-- another service's schema, never joined in SQL.
--
-- Reversal plan:
--   DROP INDEX IF EXISTS "analytics"."booking_created_events_household_occurred_at_idx";
--   DROP INDEX IF EXISTS "analytics"."booking_created_events_occurred_at_idx";
--   DROP TABLE IF EXISTS "analytics"."booking_created_events";
--   DROP INDEX IF EXISTS "analytics"."search_events_occurred_at_idx";
--   DROP TABLE IF EXISTS "analytics"."search_events";
--   DROP INDEX IF EXISTS "analytics"."outbox_consumer_dedup_dead_lettered_idx";
--   DROP TABLE IF EXISTS "analytics"."outbox_consumer_dedup";
-- Safe in isolation — no other service schema references these objects (they
-- are per-service implementation detail; cross-service refs are by id only).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-analytics prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

-- CreateTable: consumer dedup. One row per (consumer_group, event_id). The
-- CHECK pins the three-valued state vocabulary at the DB layer so an ad-hoc
-- UPDATE that drifts away from the SDK's vocabulary fails fast.
CREATE TABLE "analytics"."outbox_consumer_dedup" (
    "consumer_group"    TEXT NOT NULL,
    "event_id"          TEXT NOT NULL,
    "event_name"        TEXT NOT NULL,
    "state"             TEXT NOT NULL,
    "attempts"          INTEGER NOT NULL DEFAULT 1,
    "last_error"        TEXT,
    "first_seen_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at"      TIMESTAMPTZ(6),
    "dead_lettered_at"  TIMESTAMPTZ(6),

    CONSTRAINT "outbox_consumer_dedup_pkey" PRIMARY KEY ("consumer_group", "event_id"),
    CONSTRAINT "outbox_consumer_dedup_state_check"
      CHECK ("state" IN ('in_flight', 'processed', 'dead_lettered'))
);

-- CreateIndex (partial): ops surface for dead-lettered rows. Partial predicate
-- keeps the index small at steady state — the vast majority of rows are
-- `processed` and carry no `dead_lettered_at` (CLAUDE.md §7.3 — partial
-- indexes for status-filtered queries). Prisma's `@@index` cannot express the
-- partial predicate, so it is materialised here.
CREATE INDEX "outbox_consumer_dedup_dead_lettered_idx"
    ON "analytics"."outbox_consumer_dedup" ("consumer_group", "dead_lettered_at")
    WHERE "dead_lettered_at" IS NOT NULL;

-- CreateTable: raw `search.performed` landing. `event_id` PK = idempotency key.
CREATE TABLE "analytics"."search_events" (
    "event_id"          TEXT NOT NULL,
    "occurred_at"       TIMESTAMPTZ(6) NOT NULL,
    "actor_user_id"     TEXT NOT NULL,
    "query_text"        TEXT,
    "sort"              TEXT NOT NULL,
    "has_geo"           BOOLEAN NOT NULL,
    "applied_filters"   TEXT[] NOT NULL,
    "filter_tiers"      TEXT[] NOT NULL,
    "result_count"      INTEGER NOT NULL,
    "total_estimate"    INTEGER NOT NULL,
    "zero_results"      BOOLEAN NOT NULL,
    "page"              TEXT NOT NULL,
    "live_mode"         BOOLEAN NOT NULL,
    "producer_service"  TEXT NOT NULL,
    "consumed_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex: prep-3b windows the nightly aggregation on `occurred_at`.
CREATE INDEX "search_events_occurred_at_idx"
    ON "analytics"."search_events" ("occurred_at");

-- CreateTable: raw `booking.created` landing. `event_id` PK = idempotency key.
CREATE TABLE "analytics"."booking_created_events" (
    "event_id"                TEXT NOT NULL,
    "occurred_at"             TIMESTAMPTZ(6) NOT NULL,
    "booking_id"              TEXT NOT NULL,
    "household_id"            TEXT NOT NULL,
    "senior_id"               TEXT NOT NULL,
    "provider_id"             TEXT NOT NULL,
    "service_kind"            TEXT NOT NULL,
    "scheduled_start"         TIMESTAMPTZ(6) NOT NULL,
    "scheduled_end"           TIMESTAMPTZ(6) NOT NULL,
    "currency"                TEXT NOT NULL,
    "base_price_minor"        INTEGER NOT NULL,
    "commission_rate_bps"     INTEGER NOT NULL,
    "commission_amount_minor" INTEGER NOT NULL,
    "final_price_minor"       INTEGER NOT NULL,
    "producer_service"        TEXT NOT NULL,
    "consumed_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_created_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex: prep-3b windows on `occurred_at` for the conversion mart.
CREATE INDEX "booking_created_events_occurred_at_idx"
    ON "analytics"."booking_created_events" ("occurred_at");

-- CreateIndex: the interim conversion-join key. prep-3b correlates searches to
-- bookings by `(household_id, occurred_at window)` until prep-4's per-search
-- correlation id lands. Composite so one index scan filters by household AND
-- bounds the time window.
CREATE INDEX "booking_created_events_household_occurred_at_idx"
    ON "analytics"."booking_created_events" ("household_id", "occurred_at");
