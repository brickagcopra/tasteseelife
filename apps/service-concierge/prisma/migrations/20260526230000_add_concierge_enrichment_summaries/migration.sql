-- TS-229 — Tier-3 weekly enrichment summary.
--
-- Adds the `concierge.concierge_enrichment_summaries` table — one short weekly
-- narrative (visit highlights / wellness signals / social engagement) per
-- Tier-3 household, written by the dedicated concierge and surfaced on the
-- family-portal dashboard once published (PRD §5.1 Tier 3, §6.9; PDD §12.1).
--
-- Forward-compatible expand-only migration (CLAUDE.md §4.1) — a brand-new enum
-- + a brand-new table, so there is nothing to backfill and no existing-row
-- risk.
--
-- `household_id` is the tenant-scope key the TS-141 Prisma extension filters on
-- (every model in this service carries the household axis; `unscopedModels:
-- []`). `authored_by_user_id` / `published_by_user_id` are soft FKs into
-- `identity.users.id` — by id only, no cross-service relation (CLAUDE.md §2.3).
--
-- Week-keyed: `week_start_date` is the Monday anchoring the summarised week (a
-- DATE, no time). At most one non-deleted summary per household per week,
-- enforced by the partial unique index
-- `concierge_enrichment_summaries_one_per_household_week` (WHERE `deleted_at IS
-- NULL`). Prisma's `@@unique` cannot express the partial predicate, so the
-- index is hand-written here (the established convention — see
-- `concierge_assignments_one_active_per_household` /
-- `concierge_onboardings_one_active_per_household`).
--
-- No new RBAC permission — the admin surfaces reuse `concierge:read` /
-- `concierge:write` (added by TS-224), so no `seedRbacCatalog` re-run is
-- required for this migration.
--
-- Reversal plan (drop indexes first, then the table, then the enum):
--   DROP INDEX IF EXISTS "concierge"."concierge_enrichment_summaries_one_per_household_week";
--   DROP INDEX IF EXISTS "concierge"."concierge_enrichment_summaries_deleted_at_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_enrichment_summaries_status_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_enrichment_summaries_household_week_idx";
--   DROP TABLE IF EXISTS "concierge"."concierge_enrichment_summaries";
--   DROP TYPE IF EXISTS "concierge"."concierge_enrichment_summary_status";
-- Safe in isolation — no other service schema references these objects.
--
-- Migration authored by hand to match prisma/schema.prisma. Apply with:
--   pnpm -F @taste-and-see/service-concierge prisma:migrate:deploy

-- CreateEnum
CREATE TYPE "concierge"."concierge_enrichment_summary_status" AS ENUM (
  'draft',
  'published',
  'archived'
);

-- CreateTable
CREATE TABLE "concierge"."concierge_enrichment_summaries" (
  "id"                   TEXT NOT NULL,
  "household_id"         TEXT NOT NULL,
  "week_start_date"      DATE NOT NULL,
  "status"               "concierge"."concierge_enrichment_summary_status" NOT NULL DEFAULT 'draft',
  "headline"             TEXT NOT NULL,
  "visit_highlights"     TEXT NOT NULL,
  "wellness_signals"     TEXT NOT NULL,
  "social_engagement"    TEXT NOT NULL,
  "additional_notes"     TEXT,
  "authored_by_user_id"  TEXT,
  "published_at"         TIMESTAMPTZ(6),
  "published_by_user_id" TEXT,
  "archived_at"          TIMESTAMPTZ(6),
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMPTZ(6) NOT NULL,
  "deleted_at"           TIMESTAMPTZ(6),

  CONSTRAINT "concierge_enrichment_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Dominant read: "this household's summaries, newest-week-first" — powers the
-- family dashboard list AND the ops per-household view. Composite so one index
-- scan filters by household AND returns rows ordered by week descending.
CREATE INDEX "concierge_enrichment_summaries_household_week_idx"
  ON "concierge"."concierge_enrichment_summaries"("household_id", "week_start_date" DESC);

-- CreateIndex
-- Status-filtered ops queue ("which summaries are still drafts").
CREATE INDEX "concierge_enrichment_summaries_status_idx"
  ON "concierge"."concierge_enrichment_summaries"("status");

-- CreateIndex
-- Soft-delete filter on list reads.
CREATE INDEX "concierge_enrichment_summaries_deleted_at_idx"
  ON "concierge"."concierge_enrichment_summaries"("deleted_at");

-- CreateIndex
-- One-per-household-week invariant: at most one non-deleted summary per
-- household per Monday-anchored week. Partial predicate — Prisma's @@unique
-- cannot express it, so it is hand-written here (mirrors
-- concierge_onboardings_one_active_per_household).
CREATE UNIQUE INDEX "concierge_enrichment_summaries_one_per_household_week"
  ON "concierge"."concierge_enrichment_summaries"("household_id", "week_start_date")
  WHERE "deleted_at" IS NULL;
