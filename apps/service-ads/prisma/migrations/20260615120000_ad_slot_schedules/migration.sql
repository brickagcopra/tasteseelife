-- TS-272a — slot-schedule inventory model.
--
-- Adds the `ad_slot_schedule_status` enum + the `ads.ad_slot_schedules` table:
-- a scheduled binding of a campaign into a placement over a delivery window
-- (PRD §10.9 "Inventory management (slot scheduling)"; PDD §18.1). The five
-- predefined `ad_placements` rows are loaded separately by the idempotent
-- `seed:placements` CLI (no DML in this migration — seeds are data, not schema,
-- and run as a release Job; the same split as the service-catalog / plan /
-- chart-of-accounts seeds).
--
-- Forward-compatible / expand-only per CLAUDE.md §4.1: this migration only adds
-- a new enum + a new table + its FKs/indexes; it repurposes nothing. Enum value
-- sets evolve additively (`ALTER TYPE … ADD VALUE`) per the TS-205 / TS-220
-- convention.
--
-- Cross-service references remain by id only (CLAUDE.md §2.3). Both FKs on
-- `ad_slot_schedules` (`placement_id` → `ad_placements.id`, `campaign_id` →
-- `ad_campaigns.id`) live entirely within this service's own `ads` schema, so
-- they are declared foreign keys (ON DELETE CASCADE — a schedule is meaningless
-- once its slot or its campaign is gone).
--
-- Reversal plan:
--   DROP TABLE IF EXISTS "ads"."ad_slot_schedules";
--   DROP TYPE  IF EXISTS "ads"."ad_slot_schedule_status";
-- Safe in isolation: no other object references these (the FKs point INTO the
-- pre-existing `ad_placements` / `ad_campaigns`, never the reverse).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-ads prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- CreateEnum
CREATE TYPE "ads"."ad_slot_schedule_status" AS ENUM (
  'scheduled',
  'active',
  'paused',
  'completed',
  'archived'
);

-- CreateTable: a scheduled binding of a campaign into a placement over a
-- delivery window. `priority` orders overlapping schedules on the same slot
-- (higher served first); `start_at` is required, `end_at` is NULL for an
-- open-ended schedule. Money lives on `ad_campaigns`, not here.
CREATE TABLE "ads"."ad_slot_schedules" (
  "id"           TEXT                            NOT NULL,
  "placement_id" TEXT                            NOT NULL,
  "campaign_id"  TEXT                            NOT NULL,
  "status"       "ads"."ad_slot_schedule_status" NOT NULL DEFAULT 'scheduled',
  "priority"     INTEGER                         NOT NULL DEFAULT 0,
  "start_at"     TIMESTAMPTZ(6)                  NOT NULL,
  "end_at"       TIMESTAMPTZ(6),
  "created_at"   TIMESTAMPTZ(6)                  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(6)                  NOT NULL,

  CONSTRAINT "ad_slot_schedules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ad_slot_schedules_placement_id_fkey"
    FOREIGN KEY ("placement_id")
    REFERENCES "ads"."ad_placements"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ad_slot_schedules_campaign_id_fkey"
    FOREIGN KEY ("campaign_id")
    REFERENCES "ads"."ad_campaigns"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: "schedules booked into this slot" — delivery + admin read.
CREATE INDEX "ad_slot_schedules_placement_id_idx"
  ON "ads"."ad_slot_schedules"("placement_id");
-- CreateIndex: "schedules for this campaign" — campaign-editor reverse view.
CREATE INDEX "ad_slot_schedules_campaign_id_idx"
  ON "ads"."ad_slot_schedules"("campaign_id");
-- CreateIndex: status-filtered admin view ("which schedules are active / paused").
CREATE INDEX "ad_slot_schedules_status_idx"
  ON "ads"."ad_slot_schedules"("status");
