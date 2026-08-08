-- TS-051 — Provider application + Checkr background-check intake.
--
-- Adds two new enums and two new tables inside the existing
-- `provider` schema. No changes to the `providers` table (the row
-- shape stays narrow; certifications / specialties / languages /
-- service areas / availability all land in TS-052 / TS-053 as
-- additive sibling migrations per the expand → migrate → contract
-- discipline of CLAUDE.md §4.1).
--
-- Forward-compatible expand-only migration. New rows can be created
-- the moment the migration applies; the existing `providers` table
-- stays usable on its own (an existing pre-TS-051 row simply has no
-- matching `provider_applications` row).
--
-- Reversal plan: drop in reverse-creation order so the indexes
-- unwind before the tables and the enums after the tables.
--
--   DROP INDEX IF EXISTS "provider"."provider_background_checks_status_idx";
--   DROP INDEX IF EXISTS "provider"."provider_background_checks_provider_recent_idx";
--   DROP INDEX IF EXISTS "provider"."provider_background_checks_checkr_report_id_key";
--   DROP INDEX IF EXISTS "provider"."provider_background_checks_checkr_candidate_id_key";
--   DROP TABLE  "provider"."provider_background_checks";
--   DROP INDEX IF EXISTS "provider"."provider_applications_status_idx";
--   DROP INDEX IF EXISTS "provider"."provider_applications_provider_recent_idx";
--   DROP TABLE  "provider"."provider_applications";
--   DROP TYPE   "provider"."background_check_status";
--   DROP TYPE   "provider"."application_status";
--
-- Safe in isolation — no other table references these rows and no FK
-- / CHECK constraints rely on these enums. A rollback temporarily
-- prevents new applications and background checks but does not
-- corrupt any other provider state; existing `providers` rows stay
-- queryable.
--
-- The schema design is documented in detail on the
-- `ProviderApplication` + `ProviderBackgroundCheck` models in
-- `schema.prisma`.

-- CreateEnum: application_status ----------------------------------------
CREATE TYPE "provider"."application_status" AS ENUM (
    'submitted',
    'in_review',
    'approved',
    'rejected',
    'withdrawn'
);

-- CreateEnum: background_check_status -----------------------------------
CREATE TYPE "provider"."background_check_status" AS ENUM (
    'pending',
    'processing',
    'clear',
    'consider',
    'suspended',
    'engaged',
    'dispute',
    'canceled',
    'failed'
);

-- CreateTable: provider_applications ------------------------------------
CREATE TABLE "provider"."provider_applications" (
    "id"                TEXT                              NOT NULL,
    "provider_id"       TEXT                              NOT NULL,
    "status"            "provider"."application_status"   NOT NULL DEFAULT 'submitted',
    "applicant_notes"   TEXT,
    "reviewer_user_id"  TEXT,
    "review_notes"      TEXT,
    "submitted_at"      TIMESTAMPTZ(6)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at"       TIMESTAMPTZ(6),
    "withdrawn_at"      TIMESTAMPTZ(6),
    "created_at"        TIMESTAMPTZ(6)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ(6)                    NOT NULL,

    CONSTRAINT "provider_applications_pkey" PRIMARY KEY ("id")
);

-- Powers `GET /api/v1/providers/applications/me` ("most recent
-- application for this provider") and the ops review queue ("every
-- application for this provider, newest-first").
CREATE INDEX "provider_applications_provider_recent_idx"
    ON "provider"."provider_applications"("provider_id", "submitted_at" DESC);

-- Powers the ops queue ("show me every application currently in
-- `submitted` state awaiting review").
CREATE INDEX "provider_applications_status_idx"
    ON "provider"."provider_applications"("status");

-- CreateTable: provider_background_checks -------------------------------
CREATE TABLE "provider"."provider_background_checks" (
    "id"                       TEXT                                 NOT NULL,
    "provider_id"              TEXT                                 NOT NULL,
    "application_id"           TEXT,
    "status"                   "provider"."background_check_status" NOT NULL DEFAULT 'pending',
    "checkr_candidate_id"      TEXT                                 NOT NULL,
    "checkr_report_id"         TEXT,
    "last_event_id"            TEXT,
    "completed_at"             TIMESTAMPTZ(6),
    "payload_ciphertext"       BYTEA,
    "payload_iv"               BYTEA,
    "payload_auth_tag"         BYTEA,
    "payload_key_version"      INTEGER,
    "created_at"               TIMESTAMPTZ(6)                       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMPTZ(6)                       NOT NULL,

    CONSTRAINT "provider_background_checks_pkey" PRIMARY KEY ("id")
);

-- Checkr's `candidate.id` is the natural lookup key for the
-- create-report path; unique because we should hold at most one row
-- per candidate (a future continuous-monitoring round would emit a
-- new report id but reuse the candidate id — captured in the
-- TS-051-followup roadmap).
CREATE UNIQUE INDEX "provider_background_checks_checkr_candidate_id_key"
    ON "provider"."provider_background_checks"("checkr_candidate_id");

-- Checkr's `report.id` is the natural lookup key for inbound webhook
-- events. Partial-style uniqueness expressed via a unique index
-- (Postgres treats multiple NULL values as distinct under a regular
-- UNIQUE constraint).
CREATE UNIQUE INDEX "provider_background_checks_checkr_report_id_key"
    ON "provider"."provider_background_checks"("checkr_report_id");

-- Powers `GET /api/v1/providers/applications/me` (the latest check
-- for this provider) and the ops review page.
CREATE INDEX "provider_background_checks_provider_recent_idx"
    ON "provider"."provider_background_checks"("provider_id", "created_at" DESC);

-- Powers the ops queue ("show me every check currently in `consider`
-- awaiting manual review").
CREATE INDEX "provider_background_checks_status_idx"
    ON "provider"."provider_background_checks"("status");
