-- TS-100 — initial audit schema.
--
-- Creates the `audit` Postgres schema, the `actor_tenant_scope_type`
-- enum, the core `audit_events` row, the four indexes that power the
-- dominant read paths from PDD §17.1, and the append-only triggers
-- that enforce CLAUDE.md §17.7 ("Mutating audit log entries" is an
-- absolute prohibition) at the database layer.
--
-- Forward-compatible: subsequent migrations add (never repurpose) per
-- CLAUDE.md §4.1. The Cassandra cold-side mirror (PDD §8.3 keyspaces
-- `audit.events_by_resource` + `audit.events_by_actor`) lands as
-- TS-100-followup-1 — it's a sibling persistence path, not a schema
-- change here.
--
-- Reversal plan:
--   DROP TABLE "audit"."audit_events";
--   DROP TYPE  "audit"."actor_tenant_scope_type";
--   DROP FUNCTION "audit"."audit_events_no_mutation"();
--   DROP SCHEMA "audit";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-audit prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "audit";

-- CreateEnum
CREATE TYPE "audit"."actor_tenant_scope_type" AS ENUM (
  'global',
  'tenant',
  'household',
  'system'
);

-- CreateTable
CREATE TABLE "audit"."audit_events" (
  "id"                          TEXT                                  NOT NULL,
  "event_id"                    TEXT                                  NOT NULL,
  "occurred_at"                 TIMESTAMPTZ(6)                        NOT NULL,
  "actor_user_id"               TEXT,
  "actor_role"                  TEXT,
  "actor_tenant_scope_type"     "audit"."actor_tenant_scope_type"     NOT NULL,
  "actor_tenant_scope_id"       TEXT,
  "action"                      TEXT                                  NOT NULL,
  "resource_kind"               TEXT                                  NOT NULL,
  "resource_id"                 TEXT                                  NOT NULL,
  "before_json"                 JSONB,
  "after_json"                  JSONB,
  "ip"                          INET,
  "user_agent"                  TEXT,
  "request_id"                  TEXT,
  "trace_id"                    TEXT,
  "chain_prev_hash"             CHAR(64),
  "chain_hash"                  CHAR(64)                              NOT NULL,
  "created_at"                  TIMESTAMPTZ(6)                        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- UNIQUE on event_id — the producer-assigned dedup key. A retried
-- submission with the same event_id replays into the existing row
-- (the service-layer code reads the row and returns it; the INSERT
-- would otherwise hit P2002).
CREATE UNIQUE INDEX "audit_events_event_id_key"
  ON "audit"."audit_events"("event_id");

-- Powers "audit history for this resource" — the admin UI's
-- per-resource audit-trail view and the cold-store re-key worker.
-- Composite ordering puts the most-recent event first per resource
-- so the planner serves the dominant query as a single backward
-- index scan.
CREATE INDEX "audit_events_resource_occurred_idx"
  ON "audit"."audit_events"("resource_kind", "resource_id", "occurred_at" DESC);

-- Powers "actions performed by this admin" — the per-actor audit
-- search (PDD §17.1 "Searchable via admin UI by actor"). Excludes
-- null `actor_user_id` (system events) via the partial predicate so
-- the per-admin search index never returns the system rows.
--
-- EXPLAIN target: `SELECT ... FROM audit.audit_events
--                   WHERE actor_user_id = $1 ORDER BY occurred_at DESC
--                   LIMIT 50` should hit this index as a backward
-- index scan with no Sort node.
CREATE INDEX "audit_events_actor_occurred_idx"
  ON "audit"."audit_events"("actor_user_id", "occurred_at" DESC)
  WHERE "actor_user_id" IS NOT NULL;

-- Powers "every coupon-create in the last week" — action histograms
-- in the trust-safety dashboard (PDD §17.3).
CREATE INDEX "audit_events_action_occurred_idx"
  ON "audit"."audit_events"("action", "occurred_at" DESC);

-- Powers the 90-day-retention prune worker (TS-100-followup-3) —
-- `WHERE created_at < now() - retention`. Single-column index keeps
-- the prune query off the more complex composites.
CREATE INDEX "audit_events_created_at_idx"
  ON "audit"."audit_events"("created_at");

-- Append-only enforcement (CLAUDE.md §17.7 absolute prohibition).
--
-- The function raises EXCEPTION on every UPDATE or DELETE — psql
-- statement, admin tool, or a service-layer code regression all get
-- the same 500 from Postgres. Service-layer code only ever INSERTs.
-- Reversal (if ever needed for a SOC-2-approved audit correction —
-- which CLAUDE.md §3.6 says should be a sibling reversal row instead)
-- requires a `DROP TRIGGER ... ON "audit"."audit_events"` step
-- documented in the runbook.
CREATE OR REPLACE FUNCTION "audit"."audit_events_no_mutation"()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_events is append-only (CLAUDE.md §17.7 / §3.6); mutations are forbidden'
    USING ERRCODE = '42501';  -- insufficient_privilege
END;
$$;

CREATE TRIGGER "audit_events_no_update"
  BEFORE UPDATE ON "audit"."audit_events"
  FOR EACH ROW
  EXECUTE FUNCTION "audit"."audit_events_no_mutation"();

CREATE TRIGGER "audit_events_no_delete"
  BEFORE DELETE ON "audit"."audit_events"
  FOR EACH ROW
  EXECUTE FUNCTION "audit"."audit_events_no_mutation"();

-- TRUNCATE would bypass row triggers, so block it at the statement
-- level too. The 90-day-retention prune worker (TS-100-followup-3)
-- must use DELETE with a wholesale `OFF` on these triggers for a
-- carefully-scoped pruning window — captured in the worker's runbook.
CREATE TRIGGER "audit_events_no_truncate"
  BEFORE TRUNCATE ON "audit"."audit_events"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "audit"."audit_events_no_mutation"();
