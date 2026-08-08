-- TS-215 — saved-search + favorite-provider per-actor surfaces.
--
-- Adds two new tables to the `search` schema (already created by the
-- TS-211 init migration):
--
--   1. `saved_searches` — named snapshots of `SearchProvidersRequest`
--      bodies the family payer can re-run from the dashboard. PRD §6.3,
--      §6.4; PDD §14.1.
--
--   2. `favorite_providers` — per-actor bookmarks of providers with an
--      optional senior association ("providers we love for Mom").
--
-- Both tables are user-scoped — `owner_user_id` is non-nullable. The
-- service layer enforces that the authenticated actor's userId matches
-- the row's owner on every read / update / delete (CLAUDE.md §3.2's
-- "row-level checks on every read" — service-search does the per-row
-- check explicitly; the tenant-scope gate at the Prisma extension layer
-- (TS-141 / TS-020-followup-2b-platform-rollout-svc-search) is configured
-- to ENFORCE so an unscoped Prisma call is a runtime block).
--
-- Forward-compatible expand-only per CLAUDE.md §4.1. Reversal plan:
--   DROP TABLE "search"."favorite_providers";
--   DROP TABLE "search"."saved_searches";
-- Safe in isolation because no other service references these objects
-- (cross-service references are by id only — CLAUDE.md §2.3, §4.1).

-- ─── saved_searches ────────────────────────────────────────────────────

CREATE TABLE "search"."saved_searches" (
  "id"            TEXT           NOT NULL,
  "owner_user_id" TEXT           NOT NULL,
  "senior_id"     TEXT,
  "name"          TEXT           NOT NULL,
  -- JSONB so the SearchProvidersRequest shape can evolve additively
  -- (new optional filters, etc.) without invalidating existing rows.
  "query"         JSONB          NOT NULL,
  "last_run_at"   TIMESTAMPTZ(6),
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "saved_searches_pkey" PRIMARY KEY ("id")
);

-- The dominant read pattern is "list every saved search for this actor,
-- newest first". EXPLAIN ANALYZE on a future scale check should show an
-- index-only scan on this composite (owner_user_id, created_at DESC).
CREATE INDEX "saved_searches_owner_user_id_idx"
  ON "search"."saved_searches" ("owner_user_id", "created_at" DESC);

-- ─── favorite_providers ────────────────────────────────────────────────

CREATE TABLE "search"."favorite_providers" (
  "id"            TEXT           NOT NULL,
  "owner_user_id" TEXT           NOT NULL,
  "provider_id"   TEXT           NOT NULL,
  "senior_id"     TEXT,
  "notes"         TEXT,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "favorite_providers_pkey" PRIMARY KEY ("id")
);

-- Composite UNIQUE on (owner_user_id, provider_id, senior_id) — the
-- POST endpoint is idempotent on this tuple. Postgres' default
-- NULLS-DISTINCT semantics mean a NULL senior_id is treated as a
-- distinct value from any non-null senior_id, so an actor can have one
-- no-senior favourite + one favourite-for-Mom + one favourite-for-Dad
-- for the same provider — which is the intent.
CREATE UNIQUE INDEX "favorite_providers_owner_provider_senior_key"
  ON "search"."favorite_providers" ("owner_user_id", "provider_id", "senior_id");

-- The "list all favourites for this actor" + "list favourites for this
-- senior" read patterns. Two indices because the senior-scoped query
-- is a common UX surface ("favorites visible on the senior profile")
-- and the planner picks the matching prefix.
CREATE INDEX "favorite_providers_owner_user_id_idx"
  ON "search"."favorite_providers" ("owner_user_id", "created_at" DESC);

CREATE INDEX "favorite_providers_owner_senior_idx"
  ON "search"."favorite_providers" ("owner_user_id", "senior_id", "created_at" DESC);
