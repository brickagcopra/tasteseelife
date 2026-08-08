-- TS-226 — concierge transportation coordination.
--
-- Adds the `concierge.concierge_transportation_requests` table — the
-- FULFILMENT side of a Tier-3 transportation request (PRD §5.1 Tier 3
-- "transportation coordination", §6.6; PDD §10.6). Where `concierge_tickets`
-- is the REQUEST a family submits, a transportation request is the concrete
-- booked ride a concierge arranges: a medical appointment, a museum outing, a
-- social visit — with a pickup, a dropoff, a scheduled time, and a vendor
-- ride id.
--
-- Forward-compatible expand-only migration (CLAUDE.md §4.1) — brand-new enums
-- + a brand-new table, so there is nothing to backfill and no existing-row
-- risk.
--
-- Foreign key: `ticket_id` references `concierge.concierge_tickets(id)` — an
-- IN-SERVICE relation (both tables live in the `concierge` schema), which
-- CLAUDE.md §4.1 allows (it forbids FKs only ACROSS service schemas). The FK
-- is OPTIONAL (a ride may be concierge-initiated with no originating request)
-- and ON DELETE SET NULL — if a ticket is ever hard-deleted the ride survives
-- with its link cleared (the ride is an independent record; today tickets are
-- soft-deleted only, so this is defence-in-depth).
--
-- `household_id` is the tenant-scope key the TS-141 Prisma extension filters
-- on (every model in this service carries the household axis;
-- `unscopedModels: []`). `created_by_user_id` is a soft FK into
-- `identity.users.id` (the concierge who arranged the ride) — by id only, no
-- cross-service relation (CLAUDE.md §2.3).
--
-- `external_provider` is the Phase-3 adapter seam: `manual` (the Phase-1
-- default — the concierge booked the ride by phone / a partner app) vs
-- `uber_health` / `lyft_health` (live ride-hailing APIs wired in Phase 3,
-- TS-226-followup, which requires an SDK ADR). No external SDK is involved at
-- Phase 1. `external_reference` / `external_status` carry the vendor ride id +
-- the raw vendor status the inbound webhook mirrors back. No PII (no phone
-- number) is stored.
--
-- Reversal plan (drop indexes + FK first, then the table, then the enums):
--   DROP INDEX IF EXISTS "concierge"."concierge_transportation_requests_deleted_at_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_transportation_requests_provider_ref_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_transportation_requests_status_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_transportation_requests_ticket_id_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_transportation_requests_household_pickup_idx";
--   ALTER TABLE "concierge"."concierge_transportation_requests"
--     DROP CONSTRAINT IF EXISTS "concierge_transportation_requests_ticket_id_fkey";
--   DROP TABLE IF EXISTS "concierge"."concierge_transportation_requests";
--   DROP TYPE IF EXISTS "concierge"."concierge_transportation_provider";
--   DROP TYPE IF EXISTS "concierge"."concierge_ride_status";
-- Safe in isolation — no other service schema references these objects.
--
-- Migration authored by hand to match prisma/schema.prisma. Apply with:
--   pnpm -F @taste-and-see/service-concierge prisma:migrate:deploy

-- CreateEnum
CREATE TYPE "concierge"."concierge_ride_status" AS ENUM (
  'requested',
  'scheduled',
  'in_progress',
  'completed',
  'canceled'
);

-- CreateEnum
CREATE TYPE "concierge"."concierge_transportation_provider" AS ENUM (
  'manual',
  'uber_health',
  'lyft_health'
);

-- CreateTable
CREATE TABLE "concierge"."concierge_transportation_requests" (
  "id"                  TEXT NOT NULL,
  "household_id"        TEXT NOT NULL,
  "ticket_id"           TEXT,
  "status"              "concierge"."concierge_ride_status" NOT NULL DEFAULT 'requested',
  "external_provider"   "concierge"."concierge_transportation_provider" NOT NULL DEFAULT 'manual',
  "pickup_address"      TEXT NOT NULL,
  "dropoff_address"     TEXT NOT NULL,
  "scheduled_pickup_at" TIMESTAMPTZ(6) NOT NULL,
  "purpose"             TEXT,
  "rider_name"          TEXT,
  "external_reference"  TEXT,
  "external_status"     TEXT,
  "notes"               TEXT,
  "created_by_user_id"  TEXT NOT NULL,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6) NOT NULL,
  "deleted_at"          TIMESTAMPTZ(6),

  CONSTRAINT "concierge_transportation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Powers the dominant ops read: "this household's rides, soonest first" + the
-- cross-household upcoming view. Composite so a single index scan filters by
-- household AND returns rows ordered by pickup time without a separate sort.
CREATE INDEX "concierge_transportation_requests_household_pickup_idx"
  ON "concierge"."concierge_transportation_requests"("household_id", "scheduled_pickup_at");

-- CreateIndex
-- "Rides fulfilling this request" — the ticket → fulfilment lookup.
CREATE INDEX "concierge_transportation_requests_ticket_id_idx"
  ON "concierge"."concierge_transportation_requests"("ticket_id");

-- CreateIndex
-- Status-filtered ops views (e.g. "all in-progress rides right now").
CREATE INDEX "concierge_transportation_requests_status_idx"
  ON "concierge"."concierge_transportation_requests"("status");

-- CreateIndex
-- Webhook lookup: match an inbound vendor ride-status event by (provider, ride
-- id). Composite so the webhook handler's `findFirst({ externalProvider,
-- externalReference })` is a single index scan.
CREATE INDEX "concierge_transportation_requests_provider_ref_idx"
  ON "concierge"."concierge_transportation_requests"("external_provider", "external_reference");

-- CreateIndex
-- Soft-delete filter on list reads.
CREATE INDEX "concierge_transportation_requests_deleted_at_idx"
  ON "concierge"."concierge_transportation_requests"("deleted_at");

-- AddForeignKey
-- In-service FK to the optional originating ticket (CLAUDE.md §4.1 — allowed
-- within a single service schema). SET NULL on delete keeps the ride when its
-- ticket is removed (the ride is an independent record).
ALTER TABLE "concierge"."concierge_transportation_requests"
  ADD CONSTRAINT "concierge_transportation_requests_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "concierge"."concierge_tickets"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
