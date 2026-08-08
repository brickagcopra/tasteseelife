-- TS-211 — initial search schema + ranking config row.
--
-- Creates the `search` Postgres schema and the `search_ranking_config`
-- table that holds the per-region tier-weight multipliers consumed by
-- service-search at query time (PDD §14.1 "Tier-aware boosting (Elite >
-- Certified > Basic) configurable").
--
-- Forward-compatible expand-only per CLAUDE.md §4.1. Subsequent
-- migrations land additive columns (e.g. an `archived_at` for soft-
-- delete on per-region overrides) without breaking existing rows.
--
-- Seeded `global` row carries the TS-211 spec defaults: Elite ×1.5,
-- Certified ×1.2, Basic ×1.0. The row is load-bearing — service-search
-- falls back to it whenever a per-region row is absent. The row must
-- not be deleted (the service layer rejects with 422); ops mutates the
-- weights via PUT.
--
-- Reversal plan:
--   DELETE FROM "search"."search_ranking_config";
--   DROP TABLE "search"."search_ranking_config";
--   DROP SCHEMA "search";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only — CLAUDE.md §2.3).

CREATE SCHEMA IF NOT EXISTS "search";

-- CreateTable
CREATE TABLE "search"."search_ranking_config" (
  "id"                     TEXT             NOT NULL,
  "region_code"            TEXT             NOT NULL,
  "description"            TEXT,
  "tier_weight_basic"      DOUBLE PRECISION NOT NULL,
  "tier_weight_certified"  DOUBLE PRECISION NOT NULL,
  "tier_weight_elite"      DOUBLE PRECISION NOT NULL,
  "updated_by_user_id"     TEXT,
  "created_at"             TIMESTAMPTZ(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMPTZ(6)   NOT NULL,

  CONSTRAINT "search_ranking_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- UNIQUE on `region_code` — the natural key for the upsert path. A PUT
-- against `:regionCode` reads / writes through this index; ops cannot
-- create two rows for the same region by accident.
CREATE UNIQUE INDEX "search_ranking_config_region_code_key"
  ON "search"."search_ranking_config" ("region_code");

-- Seed the canonical `global` row. TS-211 spec defaults:
--   Elite ×1.5, Certified ×1.2, Basic ×1.0.
-- The id is a deterministic CUID-shaped string so a re-run of the seed
-- against a manually-cleared row preserves the natural-key constraint.
-- `updated_by_user_id` stays NULL — this row was placed by migration,
-- not by an actor.
INSERT INTO "search"."search_ranking_config" (
  "id",
  "region_code",
  "description",
  "tier_weight_basic",
  "tier_weight_certified",
  "tier_weight_elite",
  "updated_by_user_id",
  "created_at",
  "updated_at"
) VALUES (
  'rc_seed_global',
  'global',
  'Platform default tier weights (TS-211): Elite x1.5, Certified x1.2, Basic x1.0.',
  1.0,
  1.2,
  1.5,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("region_code") DO NOTHING;
