-- TS-043 — coupons + per-customer redemption audit trail (PRD §10.4).
--
-- Forward-only expand migration. Adds two enums + two tables in
-- `subscription` schema. No mutations to existing rows; no destructive
-- DDL. Indexes are created as part of table creation so backfill is a
-- no-op (CLAUDE.md §4.1, §4.4).
--
-- Reversal plan:
--   DROP TABLE  "subscription"."coupon_redemptions";
--   DROP TABLE  "subscription"."coupons";
--   DROP TYPE   "subscription"."coupon_duration";
--   DROP TYPE   "subscription"."coupon_kind";
-- Safe in isolation because no other service schema references these
-- tables (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-subscription prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- CreateEnum: discount mechanism
CREATE TYPE "subscription"."coupon_kind" AS ENUM (
  'percent_off',
  'amount_off',
  'extended_trial'
);

-- CreateEnum: how long the discount applies (mirrors Stripe)
CREATE TYPE "subscription"."coupon_duration" AS ENUM (
  'once',
  'repeating',
  'forever'
);

-- CreateTable: coupons
CREATE TABLE "subscription"."coupons" (
  "id"                          TEXT                                NOT NULL,
  "code"                        TEXT                                NOT NULL,
  "name"                        TEXT                                NOT NULL,
  "kind"                        "subscription"."coupon_kind"        NOT NULL,
  "amount"                      INTEGER                             NOT NULL,
  "currency"                    CHAR(3)                             NOT NULL DEFAULT 'USD',
  "duration"                    "subscription"."coupon_duration"    NOT NULL DEFAULT 'once',
  "duration_in_months"          INTEGER,
  "applies_to_plan_ids"         TEXT[]                              NOT NULL DEFAULT ARRAY[]::TEXT[],
  "max_redemptions"             INTEGER,
  "times_redeemed"              INTEGER                             NOT NULL DEFAULT 0,
  "per_customer_limit"          INTEGER                             DEFAULT 1,
  "first_time_customer_only"    BOOLEAN                             NOT NULL DEFAULT false,
  "min_spend_minor"             INTEGER,
  "stackable"                   BOOLEAN                             NOT NULL DEFAULT false,
  "expires_at"                  TIMESTAMPTZ(6),
  "active"                      BOOLEAN                             NOT NULL DEFAULT true,
  "stripe_coupon_id"            TEXT,
  "notes"                       TEXT,
  "created_by_user_id"          TEXT                                NOT NULL,
  "created_at"                  TIMESTAMPTZ(6)                      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                  TIMESTAMPTZ(6)                      NOT NULL,

  CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique code (case-normalised at the service boundary)
CREATE UNIQUE INDEX "coupons_code_key" ON "subscription"."coupons"("code");

-- CreateIndex: unique Stripe handle (NULL allowed for extended_trial)
CREATE UNIQUE INDEX "coupons_stripe_coupon_id_key" ON "subscription"."coupons"("stripe_coupon_id");

-- CreateIndex: admin "active & not-expired" rollup. Plain composite is
-- enough — a partial index `WHERE active = true` lands as a follow-up
-- only when the inactive-row population grows enough to matter.
CREATE INDEX "coupons_active_expires_idx" ON "subscription"."coupons"("active", "expires_at");

-- CreateTable: coupon_redemptions (append-only by policy)
CREATE TABLE "subscription"."coupon_redemptions" (
  "id"                  TEXT                                          NOT NULL,
  "coupon_id"           TEXT                                          NOT NULL,
  "customer_id"         TEXT                                          NOT NULL,
  "customer_group"      "subscription"."plan_customer_group"          NOT NULL,
  "subscription_id"     TEXT                                          NOT NULL,
  "value_applied_minor" INTEGER                                       NOT NULL,
  "currency"            CHAR(3)                                       NOT NULL DEFAULT 'USD',
  "redeemed_at"         TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: per-(coupon, subscription) uniqueness — race guard for
-- concurrent subscription-create flows that both pass the per-customer
-- limit check. The losing transaction surfaces a P2002 to the service.
CREATE UNIQUE INDEX "coupon_redemptions_coupon_subscription_uq"
  ON "subscription"."coupon_redemptions"("coupon_id", "subscription_id");

-- CreateIndex: per-customer redemption scroll — the `per_customer_limit`
-- check counts rows here.
CREATE INDEX "coupon_redemptions_coupon_customer_idx"
  ON "subscription"."coupon_redemptions"("coupon_id", "customer_id", "customer_group");

-- CreateIndex: per-coupon timeline — admin reporting + accounting
-- contra-revenue reconciliation.
CREATE INDEX "coupon_redemptions_coupon_redeemed_idx"
  ON "subscription"."coupon_redemptions"("coupon_id", "redeemed_at" DESC);

-- AddForeignKey: coupon_id → coupons.id (same schema, real FK allowed)
ALTER TABLE "subscription"."coupon_redemptions"
  ADD CONSTRAINT "coupon_redemptions_coupon_id_fkey"
  FOREIGN KEY ("coupon_id") REFERENCES "subscription"."coupons"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
