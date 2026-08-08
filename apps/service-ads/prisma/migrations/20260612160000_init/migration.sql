-- TS-270 — initial ads schema.
--
-- Creates the `ads` Postgres schema and the four core tables (PDD §8.2,
-- §18.1):
--   1. `ad_campaigns`       — advertiser-bound, budget-bound campaigns.
--   2. `ad_placements`      — predefined UI slots (seeded in TS-272).
--   3. `ad_creatives`       — renderable assets bound to a campaign.
--   4. `ad_targeting_rules` — per-campaign targeting predicates.
-- plus their enums and indexes. Forward-compatible: subsequent migrations add
-- (never repurpose) per CLAUDE.md §4.1, and enum value sets grow via
-- `ALTER TYPE … ADD VALUE` per the TS-205 / TS-220 convention. The impression /
-- click capture stream (TS-275) lands in the Cassandra `ads.impressions`
-- keyspace (PDD §8.3), not here.
--
-- Cross-service references are by id only (CLAUDE.md §2.3): `ad_campaigns.
-- advertiser_id` is a soft FK into service-partner / service-provider (NULL for
-- an internal house ad) — never a declared foreign key into another service
-- schema. The two in-schema FKs (`ad_creatives.campaign_id` /
-- `ad_targeting_rules.campaign_id` → `ad_campaigns.id`) live entirely within
-- this service's own `ads` schema, so they are declared FKs.
--
-- Reversal plan:
--   DROP TABLE IF EXISTS "ads"."ad_targeting_rules";
--   DROP TABLE IF EXISTS "ads"."ad_creatives";
--   DROP TABLE IF EXISTS "ads"."ad_placements";
--   DROP TABLE IF EXISTS "ads"."ad_campaigns";
--   DROP TYPE  IF EXISTS "ads"."ad_targeting_rule_kind";
--   DROP TYPE  IF EXISTS "ads"."ad_creative_status";
--   DROP TYPE  IF EXISTS "ads"."ad_creative_kind";
--   DROP TYPE  IF EXISTS "ads"."ad_campaign_status";
--   DROP TYPE  IF EXISTS "ads"."advertiser_kind";
--   DROP SCHEMA IF EXISTS "ads";
-- Safe in isolation because no other service schema references these objects
-- (cross-service references are by id only).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-ads prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "ads";

-- CreateEnum
CREATE TYPE "ads"."advertiser_kind" AS ENUM (
  'partner',
  'provider',
  'internal'
);

-- CreateEnum
CREATE TYPE "ads"."ad_campaign_status" AS ENUM (
  'draft',
  'scheduled',
  'active',
  'paused',
  'completed',
  'archived'
);

-- CreateEnum
CREATE TYPE "ads"."ad_creative_kind" AS ENUM (
  'banner',
  'sponsored_listing',
  'sponsored_content',
  'partner_card'
);

-- CreateEnum
CREATE TYPE "ads"."ad_creative_status" AS ENUM (
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'archived'
);

-- CreateEnum
CREATE TYPE "ads"."ad_targeting_rule_kind" AS ENUM (
  'geography',
  'persona',
  'tier',
  'behavior_cohort',
  'household_composition'
);

-- CreateTable: advertiser-bound, budget-bound campaigns. `budget` is the
-- optional spend cap (NULL = uncapped); `Decimal(12,2)` + explicit `currency`
-- (CLAUDE.md §4.1 — no float math for money).
CREATE TABLE "ads"."ad_campaigns" (
  "id"              TEXT                          NOT NULL,
  "name"            TEXT                          NOT NULL,
  "advertiser_kind" "ads"."advertiser_kind"       NOT NULL,
  "advertiser_id"   TEXT,
  "status"          "ads"."ad_campaign_status"    NOT NULL DEFAULT 'draft',
  "budget"          DECIMAL(12,2),
  "currency"        TEXT                          NOT NULL DEFAULT 'USD',
  "start_at"        TIMESTAMPTZ(6),
  "end_at"          TIMESTAMPTZ(6),
  "created_at"      TIMESTAMPTZ(6)                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(6)                NOT NULL,

  CONSTRAINT "ad_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: status-filtered admin view ("which campaigns are active / paused").
CREATE INDEX "ad_campaigns_status_idx" ON "ads"."ad_campaigns"("status");
-- CreateIndex: "campaigns for this advertiser" — partner / provider reporting.
CREATE INDEX "ad_campaigns_advertiser_idx"
  ON "ads"."ad_campaigns"("advertiser_kind", "advertiser_id");

-- CreateTable: predefined UI slots. `slot_code` UNIQUE so a slot is addressed
-- by code, not id (seeded in TS-272).
CREATE TABLE "ads"."ad_placements" (
  "id"                       TEXT                       NOT NULL,
  "slot_code"                TEXT                       NOT NULL,
  "supported_creative_kinds" "ads"."ad_creative_kind"[] NOT NULL,
  "created_at"               TIMESTAMPTZ(6)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMPTZ(6)             NOT NULL,

  CONSTRAINT "ad_placements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: addressed by slot code, not id.
CREATE UNIQUE INDEX "ad_placements_slot_code_key" ON "ads"."ad_placements"("slot_code");

-- CreateTable: renderable creative assets bound to a campaign. `asset_keys`
-- are S3 object keys from the media pipeline (CLAUDE.md §3.4).
CREATE TABLE "ads"."ad_creatives" (
  "id"          TEXT                          NOT NULL,
  "campaign_id" TEXT                          NOT NULL,
  "kind"        "ads"."ad_creative_kind"      NOT NULL,
  "asset_keys"  TEXT[]                        NOT NULL,
  "headline"    TEXT                          NOT NULL,
  "body"        TEXT,
  "cta_url"     TEXT,
  "status"      "ads"."ad_creative_status"    NOT NULL DEFAULT 'draft',
  "created_at"  TIMESTAMPTZ(6)                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6)                NOT NULL,

  CONSTRAINT "ad_creatives_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ad_creatives_campaign_id_fkey"
    FOREIGN KEY ("campaign_id")
    REFERENCES "ads"."ad_campaigns"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: "creatives for this campaign" — the dominant admin read.
CREATE INDEX "ad_creatives_campaign_id_idx" ON "ads"."ad_creatives"("campaign_id");
-- CreateIndex: approval-queue view ("creatives pending review").
CREATE INDEX "ad_creatives_status_idx" ON "ads"."ad_creatives"("status");

-- CreateTable: per-campaign targeting predicates. `value` carries the JSON AST
-- (TS-273) as TEXT so the schema never constrains the evolving rule grammar.
CREATE TABLE "ads"."ad_targeting_rules" (
  "id"          TEXT                              NOT NULL,
  "campaign_id" TEXT                              NOT NULL,
  "kind"        "ads"."ad_targeting_rule_kind"    NOT NULL,
  "value"       TEXT                              NOT NULL,
  "created_at"  TIMESTAMPTZ(6)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6)                    NOT NULL,

  CONSTRAINT "ad_targeting_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ad_targeting_rules_campaign_id_fkey"
    FOREIGN KEY ("campaign_id")
    REFERENCES "ads"."ad_campaigns"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: "targeting rules for this campaign" — read at delivery + edit time.
CREATE INDEX "ad_targeting_rules_campaign_id_idx"
  ON "ads"."ad_targeting_rules"("campaign_id");
