-- TS-222 — dedicated culinary-concierge assignments.
--
-- Adds the `concierge_assignments` table + its status enum inside the
-- existing `concierge` schema (PRD §5.1 Tier 3 "Dedicated culinary
-- concierge", §6.6; PDD §10.6). Links a household to a primary concierge
-- + optional backup. One active assignment per household; reassignment
-- ends the prior active row and inserts a fresh one so the history is
-- preserved (PDD §17).
--
-- Forward-compatible expand-only migration (CLAUDE.md §4.1). The TS-221
-- `concierge_tickets` table is untouched. Enum value sets grow via
-- `ALTER TYPE … ADD VALUE` per the TS-205 / TS-220 convention.
--
-- Cross-service references are by id only (CLAUDE.md §2.3): `household_id`,
-- `primary_concierge_user_id`, `backup_concierge_user_id`, and
-- `assigned_by_user_id` are soft FKs into `household.households` /
-- `identity.users` — never SQL foreign keys across service schemas.
--
-- Reversal plan (drop indexes before the table, the enum after):
--   DROP INDEX IF EXISTS "concierge"."concierge_assignments_one_active_per_household";
--   DROP INDEX IF EXISTS "concierge"."concierge_assignments_deleted_at_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_assignments_primary_user_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_assignments_household_started_idx";
--   DROP TABLE  "concierge"."concierge_assignments";
--   DROP TYPE   "concierge"."concierge_assignment_status";
-- Safe in isolation — no other service schema references these objects.
--
-- Migration authored by hand to match prisma/schema.prisma. Apply with:
--   pnpm -F @taste-and-see/service-concierge prisma:migrate:deploy

-- CreateEnum
CREATE TYPE "concierge"."concierge_assignment_status" AS ENUM (
  'active',
  'ended'
);

-- CreateTable
CREATE TABLE "concierge"."concierge_assignments" (
  "id"                             TEXT                                          NOT NULL,
  "household_id"                   TEXT                                          NOT NULL,
  "primary_concierge_user_id"      TEXT                                          NOT NULL,
  "primary_concierge_display_name" TEXT                                          NOT NULL,
  "backup_concierge_user_id"       TEXT,
  "backup_concierge_display_name"  TEXT,
  "status"                         "concierge"."concierge_assignment_status"     NOT NULL DEFAULT 'active',
  "assigned_by_user_id"            TEXT,
  "started_at"                     TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at"                       TIMESTAMPTZ(6),
  "created_at"                     TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                     TIMESTAMPTZ(6)                                NOT NULL,
  "deleted_at"                     TIMESTAMPTZ(6),

  CONSTRAINT "concierge_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Tenant-scope filter + per-household assignment-history read (active row
-- first, then ended rows newest-first): a single index scan filters by
-- household and returns rows in started_at-descending order.
CREATE INDEX "concierge_assignments_household_started_idx"
  ON "concierge"."concierge_assignments"("household_id", "started_at" DESC);

-- "Households this concierge is assigned to" — staff worklist reads.
CREATE INDEX "concierge_assignments_primary_user_idx"
  ON "concierge"."concierge_assignments"("primary_concierge_user_id");

-- Soft-delete filter on list reads.
CREATE INDEX "concierge_assignments_deleted_at_idx"
  ON "concierge"."concierge_assignments"("deleted_at");

-- At most one ACTIVE assignment per household. Partial unique index so
-- ended rows (the history) don't collide — the partial predicate scopes
-- uniqueness to the live active set. Defends the single-active invariant
-- at the DB layer against a create/create race (the service ends-then-
-- inserts in one transaction; this index is belt-and-braces). Prisma
-- cannot express the WHERE predicate, so it lives here in the migration
-- only (the ProviderCertification convention in service-provider).
CREATE UNIQUE INDEX "concierge_assignments_one_active_per_household"
  ON "concierge"."concierge_assignments"("household_id")
  WHERE "deleted_at" IS NULL AND "status" = 'active';
