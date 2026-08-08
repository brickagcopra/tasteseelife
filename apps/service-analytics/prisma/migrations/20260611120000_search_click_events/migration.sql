-- TS-217-prep-4b — raw `search.result_clicked` landing table.
--
-- service-analytics consumes the new `search.result_clicked` event
-- (TS-217-prep-4b) emitted by service-search when the family-portal reports a
-- click on a `/providers` search result. One row per click lands in
-- `analytics.search_click_events`; the CTR-by-position aggregation mart
-- (TS-217-prep-4b-followup-1) reads this table by `occurred_at` window, joining
-- to `search_events` on `search_id == search_events.event_id` (the
-- search-correlation token, TS-217-prep-4a) to derive click-through-rate per
-- result position.
--
-- `event_id` PK = idempotency key (CLAUDE.md §5.3): an idempotent
-- `createMany({ skipDuplicates: true })` no-ops a redelivered click. Each click
-- carries its OWN producer-minted `event_id`, distinct from the `search_id`
-- correlation token.
--
-- Cross-service references are by id only (CLAUDE.md §2.3): `provider_id` /
-- `actor_user_id` are soft FKs — never declared FKs, never joined in SQL. No
-- PII (CLAUDE.md §3.9).
--
-- Forward-compatible expand migration (CLAUDE.md §4.1) — additive only.
--
-- Reversal plan:
--   DROP INDEX IF EXISTS "analytics"."search_click_events_search_id_idx";
--   DROP INDEX IF EXISTS "analytics"."search_click_events_occurred_at_idx";
--   DROP TABLE IF EXISTS "analytics"."search_click_events";
-- Safe in isolation — no other service schema references this object.
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-analytics prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- CreateTable: raw `search.result_clicked` landing. `event_id` PK = idempotency key.
CREATE TABLE "analytics"."search_click_events" (
    "event_id"          TEXT NOT NULL,
    "occurred_at"       TIMESTAMPTZ(6) NOT NULL,
    "search_id"         TEXT NOT NULL,
    "actor_user_id"     TEXT NOT NULL,
    "provider_id"       TEXT NOT NULL,
    "position"          INTEGER NOT NULL,
    "producer_service"  TEXT NOT NULL,
    "consumed_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_click_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex: the CTR aggregation windows on `occurred_at`.
CREATE INDEX "search_click_events_occurred_at_idx"
    ON "analytics"."search_click_events" ("occurred_at");

-- CreateIndex: the CTR-funnel join key back to `search_events`
-- (`search_id == search_events.event_id`).
CREATE INDEX "search_click_events_search_id_idx"
    ON "analytics"."search_click_events" ("search_id");
