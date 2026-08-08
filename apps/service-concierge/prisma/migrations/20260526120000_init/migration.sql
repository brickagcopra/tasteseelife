-- TS-221 — initial concierge schema.
--
-- Creates the `concierge` Postgres schema and the `concierge_tickets`
-- base table (PDD §7.2 service inventory entry #7, §10.6 Concierge
-- Operations) plus its three enums and indexes. Forward-compatible:
-- subsequent migrations add (never repurpose) per CLAUDE.md §4.1, and
-- enum value sets grow via `ALTER TYPE … ADD VALUE` per the TS-205 /
-- TS-220 convention.
--
-- Cross-service references are by id only (CLAUDE.md §2.3): no foreign
-- keys into `household.households` or `identity.users` — those are soft
-- FKs resolved via the gateway BFF / events, never via SQL JOIN.
--
-- Reversal plan:
--   DROP TABLE "concierge"."concierge_tickets";
--   DROP TYPE  "concierge"."concierge_escalation_path";
--   DROP TYPE  "concierge"."concierge_ticket_status";
--   DROP TYPE  "concierge"."concierge_ticket_kind";
--   DROP SCHEMA "concierge";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-concierge prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "concierge";

-- CreateEnum
CREATE TYPE "concierge"."concierge_ticket_kind" AS ENUM (
  'custom_request',
  'holiday_dinner',
  'birthday_experience',
  'grocery_stocking',
  'tea_social',
  'museum_outing',
  'memory_meal',
  'transportation',
  'emergency_assistance'
);

-- CreateEnum
CREATE TYPE "concierge"."concierge_ticket_status" AS ENUM (
  'open',
  'assigned',
  'in_progress',
  'escalated',
  'resolved',
  'canceled'
);

-- CreateEnum
CREATE TYPE "concierge"."concierge_escalation_path" AS ENUM (
  'standard',
  'concierge_lead',
  'ops_manager',
  'trust_safety',
  'emergency_on_call'
);

-- CreateTable
CREATE TABLE "concierge"."concierge_tickets" (
  "id"                    TEXT                                        NOT NULL,
  "household_id"          TEXT                                        NOT NULL,
  "kind"                  "concierge"."concierge_ticket_kind"         NOT NULL,
  "status"                "concierge"."concierge_ticket_status"       NOT NULL DEFAULT 'open',
  "sla_due_at"            TIMESTAMPTZ(6),
  "assigned_to_user_id"   TEXT,
  "escalation_path"       "concierge"."concierge_escalation_path"     NOT NULL DEFAULT 'standard',
  "created_at"            TIMESTAMPTZ(6)                              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(6)                              NOT NULL,
  "deleted_at"            TIMESTAMPTZ(6),

  CONSTRAINT "concierge_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "concierge_tickets_household_id_idx"          ON "concierge"."concierge_tickets"("household_id");
CREATE INDEX "concierge_tickets_assigned_to_user_id_idx"   ON "concierge"."concierge_tickets"("assigned_to_user_id");
CREATE INDEX "concierge_tickets_deleted_at_idx"            ON "concierge"."concierge_tickets"("deleted_at");
-- Powers the ops-console queue (TS-224): filter by status, order by SLA
-- proximity, in a single index scan.
CREATE INDEX "concierge_tickets_status_sla_idx"            ON "concierge"."concierge_tickets"("status", "sla_due_at");
