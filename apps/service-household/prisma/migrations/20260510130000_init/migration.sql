-- TS-030 — initial household schema.
--
-- Creates the `household` Postgres schema and the three base tables —
-- `households`, `household_members`, `seniors` — plus their enums and
-- indexes. Forward-compatible: subsequent migrations add (never
-- repurpose) per CLAUDE.md §4.1 and §5.3 (events also evolve
-- additively). Sensitive PII for seniors (DOB, dietary, allergies,
-- dementia status, mobility, languages) is deliberately omitted here
-- and lands in TS-031 as an expand → migrate → contract migration
-- with field-level encryption.
--
-- Reversal plan:
--   DROP TABLE "household"."seniors";
--   DROP TABLE "household"."household_members";
--   DROP TABLE "household"."households";
--   DROP TYPE  "household"."senior_status";
--   DROP TYPE  "household"."household_member_role";
--   DROP TYPE  "household"."household_status";
--   DROP SCHEMA "household";
-- Safe in isolation because no other service schema references these
-- tables (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-household prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "household";

-- CreateEnum
CREATE TYPE "household"."household_status" AS ENUM (
  'pending',
  'active',
  'paused',
  'archived'
);

-- CreateEnum
CREATE TYPE "household"."household_member_role" AS ENUM (
  'primary_payer',
  'family_observer',
  'senior_user'
);

-- CreateEnum
CREATE TYPE "household"."senior_status" AS ENUM (
  'active',
  'paused',
  'archived'
);

-- CreateTable
CREATE TABLE "household"."households" (
  "id"                      TEXT                            NOT NULL,
  "primary_payer_user_id"   TEXT                            NOT NULL,
  "address_line1"           TEXT                            NOT NULL,
  "address_line2"           TEXT,
  "address_city"            TEXT                            NOT NULL,
  "address_region"          TEXT                            NOT NULL,
  "address_postal_code"     TEXT                            NOT NULL,
  "address_country"         TEXT                            NOT NULL,
  "time_zone"               TEXT                            NOT NULL,
  "status"                  "household"."household_status"  NOT NULL DEFAULT 'pending',
  "created_at"              TIMESTAMPTZ(6)                  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMPTZ(6)                  NOT NULL,
  "deleted_at"              TIMESTAMPTZ(6),

  CONSTRAINT "households_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "households_primary_payer_user_id_idx" ON "household"."households"("primary_payer_user_id");
CREATE INDEX "households_status_idx"                ON "household"."households"("status");
CREATE INDEX "households_deleted_at_idx"            ON "household"."households"("deleted_at");

-- CreateTable
CREATE TABLE "household"."household_members" (
  "id"            TEXT                                  NOT NULL,
  "household_id"  TEXT                                  NOT NULL,
  "user_id"       TEXT                                  NOT NULL,
  "member_role"   "household"."household_member_role"   NOT NULL,
  "invited_at"    TIMESTAMPTZ(6),
  "accepted_at"   TIMESTAMPTZ(6),
  "removed_at"    TIMESTAMPTZ(6),
  "created_at"    TIMESTAMPTZ(6)                        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6)                        NOT NULL,

  CONSTRAINT "household_members_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "household"."household_members"
  ADD CONSTRAINT "household_members_household_id_fkey"
  FOREIGN KEY ("household_id") REFERENCES "household"."households"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "household_members_household_id_idx"   ON "household"."household_members"("household_id");
CREATE INDEX "household_members_user_id_idx"        ON "household"."household_members"("user_id");
CREATE INDEX "household_members_user_active_idx"    ON "household"."household_members"("user_id", "removed_at");

-- CreateTable
CREATE TABLE "household"."seniors" (
  "id"            TEXT                          NOT NULL,
  "household_id"  TEXT                          NOT NULL,
  "first_name"    TEXT                          NOT NULL,
  "last_name"     TEXT                          NOT NULL,
  "display_name"  TEXT,
  "status"        "household"."senior_status"   NOT NULL DEFAULT 'active',
  "created_at"    TIMESTAMPTZ(6)                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6)                NOT NULL,
  "deleted_at"    TIMESTAMPTZ(6),

  CONSTRAINT "seniors_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "household"."seniors"
  ADD CONSTRAINT "seniors_household_id_fkey"
  FOREIGN KEY ("household_id") REFERENCES "household"."households"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "seniors_household_id_idx" ON "household"."seniors"("household_id");
CREATE INDEX "seniors_status_idx"       ON "household"."seniors"("status");
CREATE INDEX "seniors_deleted_at_idx"   ON "household"."seniors"("deleted_at");
