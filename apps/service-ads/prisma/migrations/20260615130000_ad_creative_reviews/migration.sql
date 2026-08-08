-- TS-277a — creative approval workflow + accessibility checks (PDD §18.3).
--
-- Two additions, both forward-compatible / expand-only per CLAUDE.md §4.1:
--
--   1. Five nullable / defaulted accessibility-metadata columns on
--      `ads.ad_creatives` — the declared inputs the approval-queue accessibility
--      checks evaluate (alt-text presence, WCAG contrast, motion sensitivity,
--      mandatory-disclosure acknowledgement). All existing rows take the column
--      defaults (`motion_safe` true, `disclosure_acknowledged` false, the three
--      text columns NULL); no data backfill is required.
--
--   2. The `ad_creative_review_decision` enum + the append-only
--      `ads.ad_creative_reviews` table — one immutable row per reviewer decision
--      (approve / reject / request-changes), snapshotting the accessibility
--      report at decision time. Append-only (CLAUDE.md §3.6) — there is no
--      `updated_at` and the service never UPDATEs/DELETEs a row.
--
-- Enum value sets evolve additively (`ALTER TYPE … ADD VALUE`) per the
-- TS-205 / TS-220 convention. The single FK (`creative_id` →
-- `ad_creatives.id`) lives entirely within this service's own `ads` schema, so
-- it is a declared foreign key (ON DELETE CASCADE — a review is meaningless once
-- its creative is gone). Cross-service references remain by id only.
--
-- Reversal plan:
--   DROP TABLE IF EXISTS "ads"."ad_creative_reviews";
--   DROP TYPE  IF EXISTS "ads"."ad_creative_review_decision";
--   ALTER TABLE "ads"."ad_creatives"
--     DROP COLUMN IF EXISTS "alt_text",
--     DROP COLUMN IF EXISTS "text_color",
--     DROP COLUMN IF EXISTS "background_color",
--     DROP COLUMN IF EXISTS "motion_safe",
--     DROP COLUMN IF EXISTS "disclosure_acknowledged";
-- Safe in isolation: no other object references these (the FK points INTO the
-- pre-existing `ad_creatives`, never the reverse).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-ads prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- AlterTable: accessibility metadata on the creative (the check inputs).
ALTER TABLE "ads"."ad_creatives"
  ADD COLUMN "alt_text"                TEXT,
  ADD COLUMN "text_color"              TEXT,
  ADD COLUMN "background_color"        TEXT,
  ADD COLUMN "motion_safe"             BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "disclosure_acknowledged" BOOLEAN NOT NULL DEFAULT false;

-- CreateEnum
CREATE TYPE "ads"."ad_creative_review_decision" AS ENUM (
  'approved',
  'rejected',
  'changes_requested'
);

-- CreateTable: append-only review-decision log. No `updated_at` (write-once);
-- `accessibility_report` snapshots the structured report (JSONB).
CREATE TABLE "ads"."ad_creative_reviews" (
  "id"                     TEXT                                NOT NULL,
  "creative_id"            TEXT                                NOT NULL,
  "decision"               "ads"."ad_creative_review_decision" NOT NULL,
  "reviewer_user_id"       TEXT                                NOT NULL,
  "notes"                  TEXT,
  "accessibility_passed"   BOOLEAN                             NOT NULL,
  "accessibility_report"   JSONB                               NOT NULL,
  "overrode_accessibility" BOOLEAN                             NOT NULL DEFAULT false,
  "created_at"             TIMESTAMPTZ(6)                      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ad_creative_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ad_creative_reviews_creative_id_fkey"
    FOREIGN KEY ("creative_id")
    REFERENCES "ads"."ad_creatives"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: "review history for this creative" — the dominant read.
CREATE INDEX "ad_creative_reviews_creative_id_idx"
  ON "ads"."ad_creative_reviews"("creative_id");
