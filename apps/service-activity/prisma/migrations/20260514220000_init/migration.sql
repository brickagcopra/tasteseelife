-- TS-101 — initial activity schema.
--
-- Creates the `activity` Postgres schema, the `activity_event_kind`
-- enum (15 variants — see prisma/schema.prisma for the catalog), the
-- core `activity_events` row, the three indexes that power the
-- dominant read paths from PDD §17.2 + §17.3, and the append-only
-- triggers that enforce CLAUDE.md §17.7 ("Mutating audit log entries"
-- is an absolute prohibition) at the database layer.
--
-- Forward-compatible: subsequent migrations add (never repurpose) per
-- CLAUDE.md §4.1. The Cassandra cold-side mirror (PDD §8.3 keyspace
-- `activity.events_by_user`) lands as TS-101-followup-1 — it's a
-- sibling persistence path, not a schema change here.
--
-- Reversal plan:
--   DROP TABLE "activity"."activity_events";
--   DROP TYPE  "activity"."activity_event_kind";
--   DROP FUNCTION "activity"."activity_events_no_mutation"();
--   DROP SCHEMA "activity";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-activity prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "activity";

-- CreateEnum
CREATE TYPE "activity"."activity_event_kind" AS ENUM (
  'login_success',
  'login_failure',
  'logout',
  'password_changed',
  'mfa_enrolled',
  'mfa_removed',
  'profile_changed',
  'payment_method_added',
  'payment_method_removed',
  'subscription_changed',
  'booking_created',
  'booking_canceled',
  'role_granted',
  'role_revoked',
  'suspicious_activity_flag'
);

-- CreateTable
CREATE TABLE "activity"."activity_events" (
  "id"                  TEXT                              NOT NULL,
  "event_id"            TEXT                              NOT NULL,
  "user_id"             TEXT                              NOT NULL,
  "kind"                "activity"."activity_event_kind"  NOT NULL,
  "occurred_at"         TIMESTAMPTZ(6)                    NOT NULL,
  "ip"                  INET,
  "user_agent"          TEXT,
  "device_fingerprint"  TEXT,
  "request_id"          TEXT,
  "trace_id"            TEXT,
  "metadata"            JSONB,
  "created_at"          TIMESTAMPTZ(6)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- UNIQUE on event_id — the producer-assigned dedup key. A retried
-- submission with the same event_id replays into the existing row
-- (the service-layer code reads the row and returns it; the INSERT
-- would otherwise hit P2002).
CREATE UNIQUE INDEX "activity_events_event_id_key"
  ON "activity"."activity_events"("event_id");

-- Powers the dominant query — per-user activity stream, newest first.
-- Used by `GET /api/v1/users/me/activity` (self-view) and
-- `GET /api/v1/admin/users/:userId/activity` (admin search).
--
-- EXPLAIN target: `SELECT ... FROM activity.activity_events
--                   WHERE user_id = $1 ORDER BY occurred_at DESC
--                   LIMIT 50` should hit this index as a backward
-- index scan with no Sort node.
CREATE INDEX "activity_events_user_occurred_idx"
  ON "activity"."activity_events"("user_id", "occurred_at" DESC);

-- Powers "every suspicious_activity_flag in the last week" — kind-
-- filtered scans for the trust-safety dashboard (PDD §17.3).
CREATE INDEX "activity_events_kind_occurred_idx"
  ON "activity"."activity_events"("kind", "occurred_at" DESC);

-- Powers the 90-day-retention prune worker (TS-101-followup-3) —
-- `WHERE created_at < now() - retention`. Single-column index keeps
-- the prune query off the more complex composites.
CREATE INDEX "activity_events_created_at_idx"
  ON "activity"."activity_events"("created_at");

-- Append-only enforcement (CLAUDE.md §17.7 absolute prohibition).
--
-- The function raises EXCEPTION on every UPDATE or DELETE — psql
-- statement, admin tool, or a service-layer code regression all get
-- the same 500 from Postgres. Service-layer code only ever INSERTs.
-- The 90-day-retention prune worker (TS-101-followup-3) must use
-- DELETE with a wholesale `DISABLE TRIGGER` on these triggers for a
-- carefully-scoped pruning window — documented in the worker's
-- runbook as a SOC-2-approved exemption.
CREATE OR REPLACE FUNCTION "activity"."activity_events_no_mutation"()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'activity_events is append-only (CLAUDE.md §17.7); mutations are forbidden'
    USING ERRCODE = '42501';  -- insufficient_privilege
END;
$$;

CREATE TRIGGER "activity_events_no_update"
  BEFORE UPDATE ON "activity"."activity_events"
  FOR EACH ROW
  EXECUTE FUNCTION "activity"."activity_events_no_mutation"();

CREATE TRIGGER "activity_events_no_delete"
  BEFORE DELETE ON "activity"."activity_events"
  FOR EACH ROW
  EXECUTE FUNCTION "activity"."activity_events_no_mutation"();

-- TRUNCATE bypasses row triggers, so block it at the statement level
-- too.
CREATE TRIGGER "activity_events_no_truncate"
  BEFORE TRUNCATE ON "activity"."activity_events"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "activity"."activity_events_no_mutation"();
