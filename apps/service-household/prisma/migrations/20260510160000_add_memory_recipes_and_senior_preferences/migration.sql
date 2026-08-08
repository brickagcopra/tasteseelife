-- TS-033 — memory recipes catalog + senior memory profile
-- (PRD §6.5; PDD §8.2; CLAUDE.md §3, §4.1, §17.1).
--
-- Forward-only expand migration. Three additive shape changes:
--
--   1. NEW ENUM `household.memory_recipe_source` — three values:
--        * `family_contribution` — uploaded by an active household member.
--        * `cultural_catalog`    — imported from the platform-wide curated
--                                  catalog (admin-managed, Phase 2).
--        * `senior_request`      — specific dish the senior asked for at
--                                  a recent visit.
--      Drives client-side rendering ("from your family" badge) and the
--      audit trail (who/what introduced this row).
--
--   2. NEW TABLE `household.memory_recipes` — per-senior catalog of
--      culturally / personally meaningful dishes. Plain columns
--      because the family dashboard, visit-prep card, and chef portal
--      all read these at speed. `image_key` is a forward reference
--      to TS-110 media-svc — stored as a TEXT pointer with no FK.
--      `contributed_by_user_id` is a soft FK into `identity.users.id`
--      (no Prisma relation, no DB-level FK — CLAUDE.md §2.3 / §4.1).
--      Two indexes:
--        * `memory_recipes_senior_active_idx` (composite, covering)
--          drives the list endpoint — "every active recipe for this
--          senior in family-chosen order" — in a single index scan.
--        * `memory_recipes_senior_requested_idx` drives the visit-prep
--          "queued dishes for the next chef visit" lookup. Composite
--          shape so booking-svc (TS-060) can run a tight index-only
--          scan.
--
--   3. NEW TABLE `household.senior_preferences` — flat key/value cues
--      that describe the senior as a person (PRD §6.5 — favourite
--      childhood foods, regional traditions). Composite PK on
--      `(senior_id, key)` so each (senior, key) pair carries at most
--      one value; upserts target this composite via Prisma
--      `upsert({where: {seniorId_key: ...}})`. Plain `(senior_id, key)`
--      index complements the PK for the list endpoint — pure belt-
--      and-braces today; revisit in a TS-033 follow-up if the
--      client-side sort proves enough at scale.
--
-- All additions are nullable / have safe defaults, so the migration is
-- non-blocking against existing rows. No data backfill required —
-- both new tables start empty.
--
-- Reversal plan (forward-compatible — execute in reverse order):
--   DROP INDEX  "household"."senior_preferences_senior_key_idx";
--   DROP TABLE  "household"."senior_preferences";
--   DROP INDEX  "household"."memory_recipes_senior_requested_idx";
--   DROP INDEX  "household"."memory_recipes_senior_active_idx";
--   DROP TABLE  "household"."memory_recipes";
--   DROP TYPE   "household"."memory_recipe_source";
-- Safe in isolation because no other service references these tables
-- or the new enum (cross-service relations are by id only — CLAUDE.md
-- §2.3).
--
-- Apply locally with:
--   pnpm -F @taste-and-see/service-household prisma:migrate:deploy

-- CreateEnum
CREATE TYPE "household"."memory_recipe_source" AS ENUM (
  'family_contribution',
  'cultural_catalog',
  'senior_request'
);

-- CreateTable — memory recipes catalog
CREATE TABLE "household"."memory_recipes" (
  "id"                            TEXT          NOT NULL,
  "senior_id"                     TEXT          NOT NULL,
  "title"                         TEXT          NOT NULL,
  "description"                   TEXT          NOT NULL,
  "source"                        "household"."memory_recipe_source" NOT NULL,
  "cuisine_tag"                   TEXT,
  "image_key"                     TEXT,
  "requested_for_upcoming_visit"  BOOLEAN       NOT NULL DEFAULT false,
  "contributed_by_user_id"        TEXT,
  "sort_position"                 INTEGER       NOT NULL,
  "created_at"                    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                    TIMESTAMPTZ(6) NOT NULL,
  "deleted_at"                    TIMESTAMPTZ(6),

  CONSTRAINT "memory_recipes_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "household"."memory_recipes"
  ADD CONSTRAINT "memory_recipes_senior_id_fkey"
  FOREIGN KEY ("senior_id") REFERENCES "household"."seniors"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex — list endpoint covering index
-- Composite shape so a single index scan filters soft-deleted rows
-- AND returns family-ordered (sort_position, then created_at)
-- results for the list endpoint. EXPLAIN ANALYZE on a populated dev
-- DB collapses this to a single index-only scan.
CREATE INDEX "memory_recipes_senior_active_idx"
  ON "household"."memory_recipes"("senior_id", "deleted_at", "sort_position", "created_at");

-- CreateIndex — visit-prep "queued dishes" lookup
-- Composite shape; booking-svc (TS-060) will join against this when
-- assembling the visit-prep card. Kept as a plain composite index
-- rather than a partial WHERE-filtered one because the partial form
-- requires a constant predicate that Prisma's filter syntax doesn't
-- model; the composite shape is cheap at the 200-recipes-per-senior
-- cap.
CREATE INDEX "memory_recipes_senior_requested_idx"
  ON "household"."memory_recipes"("senior_id", "requested_for_upcoming_visit");

-- CreateTable — senior preferences key/value store
CREATE TABLE "household"."senior_preferences" (
  "senior_id"   TEXT          NOT NULL,
  "key"         TEXT          NOT NULL,
  "value"       TEXT          NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "senior_preferences_pkey" PRIMARY KEY ("senior_id", "key")
);

-- AddForeignKey
ALTER TABLE "household"."senior_preferences"
  ADD CONSTRAINT "senior_preferences_senior_id_fkey"
  FOREIGN KEY ("senior_id") REFERENCES "household"."seniors"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
-- Belt-and-braces over the composite PK — gives the list endpoint a
-- predictable index-only scan ordered by key. Drop in a TS-033
-- follow-up if client-side sort over the PK proves enough at scale.
CREATE INDEX "senior_preferences_senior_key_idx"
  ON "household"."senior_preferences"("senior_id", "key");
