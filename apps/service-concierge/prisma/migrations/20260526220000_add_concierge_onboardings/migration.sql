-- TS-228 — Tier-3 onboarding ("white-glove kickoff").
--
-- Adds the `concierge.concierge_onboardings` table (one checklist-driven
-- onboarding per Tier-3 household) + the `concierge.concierge_onboarding_steps`
-- child table (six template steps per onboarding) — PRD §5.1 Tier 3, PDD §10.6.
--
-- Where the state lives: the acceptance frames the status as "persisted on the
-- subscription record", but the workflow is concierge-domain and a
-- cross-service write into the `subscription` schema is forbidden
-- (CLAUDE.md §2.3). The onboarding lives here, keyed by `household_id` (the
-- Tier-3 household), and is surfaced in admin ops + a read-only family card.
--
-- Forward-compatible expand-only migration (CLAUDE.md §4.1) — brand-new enums
-- + brand-new tables, so there is nothing to backfill and no existing-row risk.
--
-- Foreign key: `concierge_onboarding_steps.onboarding_id` references
-- `concierge.concierge_onboardings(id)` — an IN-SERVICE relation (both tables
-- live in the `concierge` schema), which CLAUDE.md §4.1 allows (it forbids FKs
-- only ACROSS service schemas). ON DELETE CASCADE keeps the checklist
-- consistent if an onboarding is ever hard-deleted (today onboardings are
-- soft-deleted only, so this is defence-in-depth).
--
-- `household_id` is the tenant-scope key the TS-141 Prisma extension filters on
-- (every model in this service carries the household axis; `unscopedModels:
-- []`). `started_by_user_id` / `completed_by_user_id` are soft FKs into
-- `identity.users.id` — by id only, no cross-service relation (CLAUDE.md §2.3).
--
-- Single-active invariant: at most one active (non-deleted) onboarding per
-- household, enforced by the partial unique index
-- `concierge_onboardings_one_active_per_household` (WHERE `deleted_at IS
-- NULL`). Prisma's `@@unique` cannot express the partial predicate, so the
-- index is hand-written here (the established convention — see
-- `concierge_assignments_one_active_per_household`).
--
-- Reversal plan (drop indexes + FK first, then the tables, then the enums):
--   DROP INDEX IF EXISTS "concierge"."concierge_onboarding_steps_household_id_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_onboarding_steps_onboarding_step_key";
--   ALTER TABLE "concierge"."concierge_onboarding_steps"
--     DROP CONSTRAINT IF EXISTS "concierge_onboarding_steps_onboarding_id_fkey";
--   DROP TABLE IF EXISTS "concierge"."concierge_onboarding_steps";
--   DROP INDEX IF EXISTS "concierge"."concierge_onboardings_one_active_per_household";
--   DROP INDEX IF EXISTS "concierge"."concierge_onboardings_deleted_at_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_onboardings_status_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_onboardings_household_id_idx";
--   DROP TABLE IF EXISTS "concierge"."concierge_onboardings";
--   DROP TYPE IF EXISTS "concierge"."concierge_onboarding_step_status";
--   DROP TYPE IF EXISTS "concierge"."concierge_onboarding_step_key";
--   DROP TYPE IF EXISTS "concierge"."concierge_onboarding_status";
-- Safe in isolation — no other service schema references these objects.
--
-- Migration authored by hand to match prisma/schema.prisma. Apply with:
--   pnpm -F @taste-and-see/service-concierge prisma:migrate:deploy

-- CreateEnum
CREATE TYPE "concierge"."concierge_onboarding_status" AS ENUM (
  'not_started',
  'in_progress',
  'completed',
  'canceled'
);

-- CreateEnum
CREATE TYPE "concierge"."concierge_onboarding_step_key" AS ENUM (
  'welcome_kickoff_call',
  'senior_preference_deep_dive',
  'family_expectation_setting',
  'assign_dedicated_concierge',
  'schedule_first_chef_visit',
  'confirm_household_access'
);

-- CreateEnum
CREATE TYPE "concierge"."concierge_onboarding_step_status" AS ENUM (
  'pending',
  'completed',
  'skipped'
);

-- CreateTable
CREATE TABLE "concierge"."concierge_onboardings" (
  "id"                   TEXT NOT NULL,
  "household_id"         TEXT NOT NULL,
  "status"               "concierge"."concierge_onboarding_status" NOT NULL DEFAULT 'not_started',
  "kickoff_scheduled_at" TIMESTAMPTZ(6),
  "notes"                TEXT,
  "started_by_user_id"   TEXT,
  "completed_at"         TIMESTAMPTZ(6),
  "canceled_at"          TIMESTAMPTZ(6),
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMPTZ(6) NOT NULL,
  "deleted_at"           TIMESTAMPTZ(6),

  CONSTRAINT "concierge_onboardings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concierge"."concierge_onboarding_steps" (
  "id"                   TEXT NOT NULL,
  "onboarding_id"        TEXT NOT NULL,
  "household_id"         TEXT NOT NULL,
  "step_key"             "concierge"."concierge_onboarding_step_key" NOT NULL,
  "status"               "concierge"."concierge_onboarding_step_status" NOT NULL DEFAULT 'pending',
  "sort_position"        INTEGER NOT NULL,
  "notes"                TEXT,
  "completed_at"         TIMESTAMPTZ(6),
  "completed_by_user_id" TEXT,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "concierge_onboarding_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Tenant-scope filter + "this household's onboarding" read.
CREATE INDEX "concierge_onboardings_household_id_idx"
  ON "concierge"."concierge_onboardings"("household_id");

-- CreateIndex
-- Status-filtered ops queue ("which onboardings are still in progress").
CREATE INDEX "concierge_onboardings_status_idx"
  ON "concierge"."concierge_onboardings"("status");

-- CreateIndex
-- Soft-delete filter on list reads.
CREATE INDEX "concierge_onboardings_deleted_at_idx"
  ON "concierge"."concierge_onboardings"("deleted_at");

-- CreateIndex
-- Single-active invariant: at most one non-deleted onboarding per household.
-- Partial predicate — Prisma's @@unique cannot express it, so it is
-- hand-written here (mirrors concierge_assignments_one_active_per_household).
CREATE UNIQUE INDEX "concierge_onboardings_one_active_per_household"
  ON "concierge"."concierge_onboardings"("household_id")
  WHERE "deleted_at" IS NULL;

-- CreateIndex
-- One row per (onboarding, step) — the seed + every step update upsert here.
CREATE UNIQUE INDEX "concierge_onboarding_steps_onboarding_step_key"
  ON "concierge"."concierge_onboarding_steps"("onboarding_id", "step_key");

-- CreateIndex
-- Tenant-scope filter + "all steps for this household" reads.
CREATE INDEX "concierge_onboarding_steps_household_id_idx"
  ON "concierge"."concierge_onboarding_steps"("household_id");

-- AddForeignKey
-- In-service FK to the parent onboarding (CLAUDE.md §4.1 — allowed within a
-- single service schema). CASCADE on delete keeps the checklist consistent.
ALTER TABLE "concierge"."concierge_onboarding_steps"
  ADD CONSTRAINT "concierge_onboarding_steps_onboarding_id_fkey"
  FOREIGN KEY ("onboarding_id") REFERENCES "concierge"."concierge_onboardings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
