-- TS-207 — featured-placement scheduling.
--
-- Adds the `search.featured_placements` table that holds the scheduled
-- featured windows service-search's ranking layer consults at query time
-- to boost a provider in discovery results (PRD §7.2 "Featured placement
-- for higher tiers"; §10.5 "Featured placement scheduling"; PDD §14.1).
--
-- The boost is resolved per query (region/tier context + wall-clock window),
-- mirroring the TS-211 `search_ranking_config` tier-weight resolver — the
-- search-indexer is uninvolved because a context-dependent, time-windowed
-- boost can't be baked into the indexed document.
--
-- Forward-compatible expand-only per CLAUDE.md §4.1 — a new table, no
-- changes to existing rows. `provider_id` / `created_by_user_id` are soft
-- FKs (no cross-service referential integrity — CLAUDE.md §2.3); `tier` is
-- free TEXT validated against the contract enum at the application boundary.
--
-- Reversal plan:
--   DROP TABLE "search"."featured_placements";
-- Safe in isolation — no other object references this table.

-- CreateTable
CREATE TABLE "search"."featured_placements" (
  "id"                  TEXT             NOT NULL,
  "provider_id"         TEXT             NOT NULL,
  "region_code"         TEXT,
  "tier"                TEXT,
  "boost_multiplier"    DOUBLE PRECISION NOT NULL,
  "starts_at"           TIMESTAMPTZ(6)   NOT NULL,
  "ends_at"             TIMESTAMPTZ(6)   NOT NULL,
  "note"                TEXT,
  "created_by_user_id"  TEXT,
  "created_at"          TIMESTAMPTZ(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6)   NOT NULL,

  CONSTRAINT "featured_placements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- `ends_at` powers the query-time "active or future" fetch
-- (`WHERE ends_at > now()`) the cached resolver runs on a cache miss.
CREATE INDEX "featured_placements_ends_at_idx"
  ON "search"."featured_placements" ("ends_at");

-- CreateIndex
-- `provider_id` powers the admin list-by-provider filter + the per-provider
-- boost lookup the ranking layer performs against the active set.
CREATE INDEX "featured_placements_provider_id_idx"
  ON "search"."featured_placements" ("provider_id");
