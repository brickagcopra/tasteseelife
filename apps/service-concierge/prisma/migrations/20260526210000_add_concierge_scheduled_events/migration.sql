-- TS-227 — concierge scheduled events (event dining + social outings).
--
-- Adds the `concierge.concierge_scheduled_events` table — the FULFILMENT
-- side of a concierge request (PRD §5.1 Tier 3 "social outings · event
-- dining", §6.6; PDD §10.6). Where `concierge_tickets` is the REQUEST a
-- family submits, a scheduled event is the concrete booked experience a
-- concierge arranges to fulfil it: a restaurant reservation, a museum /
-- cultural event, or a group outing — with a venue, a scheduled time, a
-- party size, and a confirmation reference.
--
-- Forward-compatible expand-only migration (CLAUDE.md §4.1) — brand-new
-- enums + a brand-new table, so there is nothing to backfill and no
-- existing-row risk.
--
-- Foreign key: `ticket_id` references `concierge.concierge_tickets(id)` —
-- an IN-SERVICE relation (both tables live in the `concierge` schema), which
-- CLAUDE.md §4.1 allows (it forbids FKs only ACROSS service schemas). The FK
-- is OPTIONAL (a scheduled event may be concierge-initiated with no
-- originating request) and ON DELETE SET NULL — if a ticket is ever
-- hard-deleted the event survives with its link cleared (the event is an
-- independent record; today tickets are soft-deleted only, so this is
-- defence-in-depth).
--
-- `household_id` is the tenant-scope key the TS-141 Prisma extension filters
-- on (every model in this service carries the household axis;
-- `unscopedModels: []`). `created_by_user_id` is a soft FK into
-- `identity.users.id` (the concierge who scheduled the event) — by id only,
-- no cross-service relation (CLAUDE.md §2.3).
--
-- `external_provider` is the Phase-3 adapter seam: `manual` (the Phase-1
-- default — the concierge booked by phone / in person) vs `opentable` /
-- `museum` (live partner APIs wired in Phase 3, TS-227-followup-5). No
-- external SDK is involved at Phase 1.
--
-- Reversal plan (drop indexes + FK first, then the table, then the enums):
--   DROP INDEX IF EXISTS "concierge"."concierge_scheduled_events_deleted_at_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_scheduled_events_status_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_scheduled_events_ticket_id_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_scheduled_events_household_start_idx";
--   ALTER TABLE "concierge"."concierge_scheduled_events"
--     DROP CONSTRAINT IF EXISTS "concierge_scheduled_events_ticket_id_fkey";
--   DROP TABLE IF EXISTS "concierge"."concierge_scheduled_events";
--   DROP TYPE IF EXISTS "concierge"."concierge_event_external_provider";
--   DROP TYPE IF EXISTS "concierge"."concierge_event_status";
--   DROP TYPE IF EXISTS "concierge"."concierge_event_kind";
-- Safe in isolation — no other service schema references these objects.
--
-- Migration authored by hand to match prisma/schema.prisma. Apply with:
--   pnpm -F @taste-and-see/service-concierge prisma:migrate:deploy

-- CreateEnum
CREATE TYPE "concierge"."concierge_event_kind" AS ENUM (
  'restaurant_reservation',
  'cultural_event',
  'group_outing'
);

-- CreateEnum
CREATE TYPE "concierge"."concierge_event_status" AS ENUM (
  'proposed',
  'confirmed',
  'completed',
  'canceled'
);

-- CreateEnum
CREATE TYPE "concierge"."concierge_event_external_provider" AS ENUM (
  'manual',
  'opentable',
  'museum'
);

-- CreateTable
CREATE TABLE "concierge"."concierge_scheduled_events" (
  "id"                 TEXT NOT NULL,
  "household_id"       TEXT NOT NULL,
  "ticket_id"          TEXT,
  "kind"               "concierge"."concierge_event_kind" NOT NULL,
  "status"             "concierge"."concierge_event_status" NOT NULL DEFAULT 'proposed',
  "title"              TEXT NOT NULL,
  "venue_name"         TEXT,
  "venue_address"      TEXT,
  "scheduled_start"    TIMESTAMPTZ(6) NOT NULL,
  "scheduled_end"      TIMESTAMPTZ(6),
  "party_size"         INTEGER,
  "external_provider"  "concierge"."concierge_event_external_provider" NOT NULL DEFAULT 'manual',
  "external_reference" TEXT,
  "notes"              TEXT,
  "created_by_user_id" TEXT NOT NULL,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL,
  "deleted_at"         TIMESTAMPTZ(6),

  CONSTRAINT "concierge_scheduled_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Powers the dominant ops read: "this household's events, soonest first" +
-- the cross-household upcoming view. Composite so a single index scan filters
-- by household AND returns rows ordered by start time without a separate sort.
CREATE INDEX "concierge_scheduled_events_household_start_idx"
  ON "concierge"."concierge_scheduled_events"("household_id", "scheduled_start");

-- CreateIndex
-- "Events fulfilling this request" — the ticket → fulfilment lookup.
CREATE INDEX "concierge_scheduled_events_ticket_id_idx"
  ON "concierge"."concierge_scheduled_events"("ticket_id");

-- CreateIndex
-- Status-filtered ops views (e.g. "all proposed events awaiting confirmation").
CREATE INDEX "concierge_scheduled_events_status_idx"
  ON "concierge"."concierge_scheduled_events"("status");

-- CreateIndex
-- Soft-delete filter on list reads.
CREATE INDEX "concierge_scheduled_events_deleted_at_idx"
  ON "concierge"."concierge_scheduled_events"("deleted_at");

-- AddForeignKey
-- In-service FK to the optional originating ticket (CLAUDE.md §4.1 — allowed
-- within a single service schema). SET NULL on delete keeps the event when
-- its ticket is removed (the event is an independent record).
ALTER TABLE "concierge"."concierge_scheduled_events"
  ADD CONSTRAINT "concierge_scheduled_events_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "concierge"."concierge_tickets"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
