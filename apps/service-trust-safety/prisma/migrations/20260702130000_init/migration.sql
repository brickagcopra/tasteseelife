-- TS-300 — initial trust_safety schema.
--
-- Creates the `trust_safety` Postgres schema and two tables (PRD §10.14,
-- PDD §16):
--   1. `incidents`      — severity-triaged trust & safety reports with SLA
--                         timers computed at insert.
--   2. `outbox_events`  — the canonical transactional outbox (PDD §7.3,
--                         CLAUDE.md §5.3). This service is the designated
--                         publisher of `welfare.flagged` (PDD §7.4); the
--                         first producer lands with TS-302. Shape identical
--                         to every other producer service's table — the
--                         `@taste-and-see/nest-outbox` SDK is schema-agnostic.
-- plus the four incident enums and indexes. Forward-compatible: subsequent
-- migrations add (never repurpose) per CLAUDE.md §4.1, and enum value sets
-- grow via `ALTER TYPE … ADD VALUE` per the TS-205 / TS-220 convention.
--
-- Cross-service references are by id only (CLAUDE.md §2.3): `incidents.
-- household_id` / `senior_id` / `provider_id` are soft references into
-- service-household / service-provider — never declared foreign keys into
-- another service schema. All three are nullable because an incident may
-- concern any subset of subjects.
--
-- Reversal plan:
--   DROP INDEX IF EXISTS "trust_safety"."trust_safety_outbox_events_undispatched_idx";
--   DROP INDEX IF EXISTS "trust_safety"."trust_safety_outbox_events_event_name_idx";
--   DROP TABLE IF EXISTS "trust_safety"."outbox_events";
--   DROP INDEX IF EXISTS "trust_safety"."trust_safety_incidents_unresolved_sla_idx";
--   DROP INDEX IF EXISTS "trust_safety"."trust_safety_incidents_provider_id_idx";
--   DROP INDEX IF EXISTS "trust_safety"."trust_safety_incidents_senior_id_idx";
--   DROP INDEX IF EXISTS "trust_safety"."trust_safety_incidents_household_id_idx";
--   DROP TABLE IF EXISTS "trust_safety"."incidents";
--   DROP TYPE  IF EXISTS "trust_safety"."incident_category";
--   DROP TYPE  IF EXISTS "trust_safety"."incident_source";
--   DROP TYPE  IF EXISTS "trust_safety"."incident_status";
--   DROP TYPE  IF EXISTS "trust_safety"."incident_severity";
--   DROP SCHEMA IF EXISTS "trust_safety";
-- Safe in isolation because no other service schema references these objects
-- (cross-service references are by id only).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly AND to
-- materialise the two partial indexes Prisma's `@@index` syntax cannot
-- express. Apply locally with:
--   pnpm -F @taste-and-see/service-trust-safety prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "trust_safety";

-- CreateEnum: severity drives the SLA budget applied at insert (PDD §16.1).
CREATE TYPE "trust_safety"."incident_severity" AS ENUM (
  'low',
  'medium',
  'high',
  'critical'
);

-- CreateEnum: incident lifecycle (open → triaging → awaiting_review → resolved).
CREATE TYPE "trust_safety"."incident_status" AS ENUM (
  'open',
  'triaging',
  'awaiting_review',
  'resolved'
);

-- CreateEnum: who filed the incident. `system` = event-driven ingestion
-- (welfare visit-flags, moderation webhooks, abuse sweeps).
CREATE TYPE "trust_safety"."incident_source" AS ENUM (
  'family',
  'senior',
  'provider',
  'concierge',
  'system'
);

-- CreateEnum: TS-301 intake taxonomy, shipped in the skeleton so the intake
-- slice needs no expand migration.
CREATE TYPE "trust_safety"."incident_category" AS ENUM (
  'welfare',
  'safety',
  'billing',
  'conduct'
);

-- CreateTable: severity-triaged trust & safety incidents.
CREATE TABLE "trust_safety"."incidents" (
  "id"               TEXT                                NOT NULL,
  "household_id"     TEXT,
  "senior_id"        TEXT,
  "provider_id"      TEXT,
  "source"           "trust_safety"."incident_source"    NOT NULL,
  "category"         "trust_safety"."incident_category"  NOT NULL,
  "severity"         "trust_safety"."incident_severity"  NOT NULL,
  "status"           "trust_safety"."incident_status"    NOT NULL DEFAULT 'open',
  "opened_at"        TIMESTAMPTZ(6)                      NOT NULL,
  "sla_due_at"       TIMESTAMPTZ(6)                      NOT NULL,
  "resolved_at"      TIMESTAMPTZ(6),
  "resolution_notes" TEXT,
  "created_at"       TIMESTAMPTZ(6)                      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(6)                      NOT NULL,

  CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: subject-id scrolls — the operator queue's dominant filters
-- ("incidents for household X / senior Y / provider Z", PDD §16.1 360-view)
-- and the row-level scoping predicates (CLAUDE.md §3.2).
CREATE INDEX "trust_safety_incidents_household_id_idx"
    ON "trust_safety"."incidents" ("household_id");
CREATE INDEX "trust_safety_incidents_senior_id_idx"
    ON "trust_safety"."incidents" ("senior_id");
CREATE INDEX "trust_safety_incidents_provider_id_idx"
    ON "trust_safety"."incidents" ("provider_id");

-- CreateIndex (partial): the future SLA-breach sweep's dominant query
-- (TS-306) — "unresolved incidents whose sla_due_at has passed, oldest due
-- first". EXPLAIN sketch: an index scan over this partial index with a range
-- condition on sla_due_at; the partial predicate keeps the index bounded to
-- live incidents because at steady state most rows are resolved (CLAUDE.md
-- §7.3 — partial indexes for status-filtered queries). Prisma's `@@index`
-- cannot express the predicate, so it is materialised here.
CREATE INDEX "trust_safety_incidents_unresolved_sla_idx"
    ON "trust_safety"."incidents" ("sla_due_at")
    WHERE "resolved_at" IS NULL;

-- CreateTable: canonical transactional outbox (see header comment).
CREATE TABLE "trust_safety"."outbox_events" (
    "event_id"         TEXT NOT NULL,
    "event_name"       TEXT NOT NULL,
    "payload"          JSONB NOT NULL,
    "occurred_at"      TIMESTAMPTZ(6) NOT NULL,
    "producer_service" TEXT NOT NULL,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at"    TIMESTAMPTZ(6),
    "attempts"         INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at"  TIMESTAMPTZ(6),
    "last_error"       TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex: secondary scroll by event_name (admin filters / metrics).
CREATE INDEX "trust_safety_outbox_events_event_name_idx"
    ON "trust_safety"."outbox_events" ("event_name");

-- CreateIndex (partial): the relay's dominant query — "give me the next batch
-- of undispatched rows ordered by created_at" (CLAUDE.md §7.3).
CREATE INDEX "trust_safety_outbox_events_undispatched_idx"
    ON "trust_safety"."outbox_events" ("created_at")
    WHERE "dispatched_at" IS NULL;
