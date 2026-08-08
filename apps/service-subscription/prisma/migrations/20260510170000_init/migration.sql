-- TS-040 — initial subscription schema.
--
-- Creates the `subscription` Postgres schema and the `plans` catalog table.
-- The subscription bounded context's full shape (per PDD §8.2) — subscriptions,
-- subscription_history, coupons, coupon_redemptions, invoices,
-- invoice_line_items, payment_methods — lands as task-by-task expand-only
-- migrations alongside the service code that populates each table (TS-041
-- onward).
--
-- Forward-compatible: subsequent migrations add (never repurpose) per
-- CLAUDE.md §4.1 and §5.3 (events also evolve additively).
--
-- Reversal plan:
--   DROP TABLE "subscription"."plans";
--   DROP TYPE  "subscription"."plan_customer_group";
--   DROP SCHEMA "subscription";
-- Safe in isolation because no other service schema references these
-- tables (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-subscription prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "subscription";

-- CreateEnum
CREATE TYPE "subscription"."plan_customer_group" AS ENUM (
  'family',
  'provider',
  'academy'
);

-- CreateTable
CREATE TABLE "subscription"."plans" (
  "id"               TEXT                                          NOT NULL,
  "code"             TEXT                                          NOT NULL,
  "name"             TEXT                                          NOT NULL,
  "description"      TEXT,
  "customer_group"   "subscription"."plan_customer_group"          NOT NULL,
  "monthly_price"    DECIMAL(12,2)                                 NOT NULL,
  "annual_price"     DECIMAL(12,2)                                 NOT NULL,
  "currency"         CHAR(3)                                       NOT NULL DEFAULT 'USD',
  "features"         JSONB                                         NOT NULL DEFAULT '[]',
  "active"           BOOLEAN                                       NOT NULL DEFAULT true,
  "sort_position"    INTEGER                                       NOT NULL DEFAULT 0,
  "created_at"       TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(6)                                NOT NULL,

  CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — `code` is the stable identifier referenced in events + reports
CREATE UNIQUE INDEX "plans_code_key" ON "subscription"."plans"("code");

-- CreateIndex — pricing-page list query: WHERE active = true AND customer_group = $1 ORDER BY sort_position, code
-- Composite covering index so a single scan filters AND orders.
CREATE INDEX "plans_active_customer_group_sort_idx"
  ON "subscription"."plans"("active", "customer_group", "sort_position", "code");
