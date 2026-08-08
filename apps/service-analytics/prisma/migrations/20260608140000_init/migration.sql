-- TS-217-prep-2 — initial analytics schema.
--
-- Creates the `analytics` Postgres schema and ONE placeholder table —
-- `analytics_aggregation_runs` (PDD §7.2 service inventory entry #17,
-- §23.1 "aggregated nightly to PostgreSQL marts") plus its status enum and
-- indexes. Forward-compatible: subsequent migrations add (never repurpose)
-- per CLAUDE.md §4.1, and enum value sets grow via `ALTER TYPE … ADD VALUE`
-- per the TS-205 / TS-220 convention. TS-217-prep-3 introduces the raw-event
-- landing + the search-relevance mart tables alongside this run-log table.
--
-- Cross-service references are by id only (CLAUDE.md §2.3): analytics is a
-- read-side projection built from domain events; it never declares a foreign
-- key into another service schema and never joins one in SQL.
--
-- Reversal plan:
--   DROP TABLE "analytics"."analytics_aggregation_runs";
--   DROP TYPE  "analytics"."analytics_aggregation_run_status";
--   DROP SCHEMA "analytics";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-analytics prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "analytics";

-- CreateEnum
CREATE TYPE "analytics"."analytics_aggregation_run_status" AS ENUM (
  'running',
  'succeeded',
  'failed'
);

-- CreateTable
CREATE TABLE "analytics"."analytics_aggregation_runs" (
  "id"             TEXT                                                NOT NULL,
  "job_name"       TEXT                                                NOT NULL,
  "status"         "analytics"."analytics_aggregation_run_status"      NOT NULL DEFAULT 'running',
  "window_start"   TIMESTAMPTZ(6)                                      NOT NULL,
  "window_end"     TIMESTAMPTZ(6)                                      NOT NULL,
  "event_count"    INTEGER,
  "error_summary"  TEXT,
  "started_at"     TIMESTAMPTZ(6)                                      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at"   TIMESTAMPTZ(6),
  "created_at"     TIMESTAMPTZ(6)                                      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(6)                                      NOT NULL,

  CONSTRAINT "analytics_aggregation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Dominant ops read: "latest runs for this job, newest first" — filter by job
-- AND return rows ordered by start time in a single index scan.
CREATE INDEX "analytics_aggregation_runs_job_started_idx"
  ON "analytics"."analytics_aggregation_runs"("job_name", "started_at" DESC);
-- Status-filtered ops view ("which runs are still running / failed").
CREATE INDEX "analytics_aggregation_runs_status_idx"
  ON "analytics"."analytics_aggregation_runs"("status");
