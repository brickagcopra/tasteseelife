-- TS-060 — initial booking schema.
--
-- Creates the `booking` Postgres schema and the core `bookings` row —
-- the row that records every chef visit, companion dining session,
-- concierge service request, or grocery coordination booking on the
-- platform — plus the two enums (`booking_status`, `service_kind`)
-- bounding the lifecycle state machine (PDD §9.2 + PRD §6.3) and the
-- catalog of bookable service types.
--
-- Forward-compatible: subsequent migrations add (never repurpose) per
-- CLAUDE.md §4.1. Recurring metadata (TS-061), visit notes (TS-062),
-- geo check-ins (TS-063), and disputes (TS-065) arrive as sibling
-- tables in future migrations (see schema.prisma header).
--
-- Reversal plan:
--   DROP TABLE "booking"."bookings";
--   DROP TYPE  "booking"."service_kind";
--   DROP TYPE  "booking"."booking_status";
--   DROP SCHEMA "booking";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-booking prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "booking";

-- CreateEnum
CREATE TYPE "booking"."booking_status" AS ENUM (
  'pending',
  'confirmed',
  'in_progress',
  'completed',
  'canceled'
);

-- CreateEnum
CREATE TYPE "booking"."service_kind" AS ENUM (
  'companion_dining',
  'personal_chef_visit',
  'grocery_coordination',
  'transportation',
  'social_outing',
  'event_dining',
  'emergency_concierge'
);

-- CreateTable
CREATE TABLE "booking"."bookings" (
  "id"                    TEXT                            NOT NULL,
  "household_id"          TEXT                            NOT NULL,
  "senior_id"             TEXT                            NOT NULL,
  "provider_id"           TEXT                            NOT NULL,
  "service_kind"          "booking"."service_kind"        NOT NULL,
  "status"                "booking"."booking_status"      NOT NULL DEFAULT 'pending',
  "scheduled_start"       TIMESTAMPTZ(6)                  NOT NULL,
  "scheduled_end"         TIMESTAMPTZ(6)                  NOT NULL,
  "currency"              CHAR(3)                         NOT NULL,
  "base_price"            DECIMAL(12,2)                   NOT NULL,
  "commission_rate"       DECIMAL(5,4)                    NOT NULL,
  "commission_amount"     DECIMAL(12,2)                   NOT NULL,
  "final_price"           DECIMAL(12,2)                   NOT NULL,
  "booking_notes"         TEXT,
  "completed_at"          TIMESTAMPTZ(6),
  "canceled_at"           TIMESTAMPTZ(6),
  "cancellation_reason"   TEXT,
  "created_at"            TIMESTAMPTZ(6)                  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(6)                  NOT NULL,

  CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Composite (household_id, scheduled_start) powers the family-portal
-- "upcoming bookings for my household" read path. Index ordering matches
-- the planner-style UI scan so the query is a single index range, not
-- a heap sort.
CREATE INDEX "bookings_household_scheduled_idx"
  ON "booking"."bookings"("household_id", "scheduled_start");

-- Composite (provider_id, scheduled_start) powers the provider-portal
-- "upcoming bookings on my calendar" read path.
CREATE INDEX "bookings_provider_scheduled_idx"
  ON "booking"."bookings"("provider_id", "scheduled_start");

-- Single-column status index powers the ops queue ("show me every
-- booking still in `pending` awaiting provider response"). Selective
-- at scale because the long-lived states are `confirmed` / `completed`
-- (most rows) and `pending` is short-lived by design. A partial
-- predicate `WHERE status = 'pending'` is the natural follow-up once
-- the absolute volume in `confirmed` and `completed` dominates — see
-- the TS-041a / TS-042 partial-index follow-ups for the same pattern.
CREATE INDEX "bookings_status_idx"
  ON "booking"."bookings"("status");

-- Composite (senior_id, scheduled_start) powers the wellness-summary
-- aggregation (PRD §6.4 / §6.9: "Monthly automated wellness summary
-- emailed to family") which scans by senior + time range.
CREATE INDEX "bookings_senior_scheduled_idx"
  ON "booking"."bookings"("senior_id", "scheduled_start");
