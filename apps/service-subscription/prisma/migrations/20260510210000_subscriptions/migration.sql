-- TS-041b — per-customer subscription rows + the audit log + payment-method
-- cache + invoice envelope.
--
-- Forward-only expand migration. Adds five tables, six enums, and a single
-- nullable column (`stripe_product_id`) to the existing `plans` table.
-- The new column is additive (NULLable, no default-required-not-null) so
-- existing seeded rows survive untouched (CLAUDE.md §4.1, §5.3).
--
-- Reversal plan:
--   DROP TABLE "subscription"."invoice_line_items";
--   DROP TABLE "subscription"."invoices";
--   DROP TABLE "subscription"."payment_methods";
--   DROP TABLE "subscription"."subscription_history";
--   DROP TABLE "subscription"."subscriptions";
--   DROP TYPE  "subscription"."invoice_line_item_kind";
--   DROP TYPE  "subscription"."invoice_status";
--   DROP TYPE  "subscription"."payment_method_kind";
--   DROP TYPE  "subscription"."subscription_history_event";
--   DROP TYPE  "subscription"."subscription_cancel_reason";
--   DROP TYPE  "subscription"."billing_interval";
--   DROP TYPE  "subscription"."subscription_status";
-- Safe in isolation because no other service schema references these
-- tables (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-subscription prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- AlterTable: lazy-initialised Stripe Product id linked to each Plan
ALTER TABLE "subscription"."plans"
  ADD COLUMN "stripe_product_id" TEXT;

-- CreateEnum
CREATE TYPE "subscription"."subscription_status" AS ENUM (
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'paused'
);

-- CreateEnum
CREATE TYPE "subscription"."billing_interval" AS ENUM (
  'monthly',
  'annual'
);

-- CreateEnum
CREATE TYPE "subscription"."subscription_cancel_reason" AS ENUM (
  'customer_request',
  'payment_failure',
  'fraud',
  'admin_action',
  'partner_termination'
);

-- CreateEnum
CREATE TYPE "subscription"."subscription_history_event" AS ENUM (
  'created',
  'status_changed',
  'plan_changed',
  'payment_method_changed',
  'trial_extended',
  'paused',
  'resumed',
  'canceled',
  'reactivated'
);

-- CreateEnum
CREATE TYPE "subscription"."payment_method_kind" AS ENUM (
  'card',
  'bank_account'
);

-- CreateEnum
CREATE TYPE "subscription"."invoice_status" AS ENUM (
  'draft',
  'open',
  'paid',
  'void',
  'uncollectible'
);

-- CreateEnum
CREATE TYPE "subscription"."invoice_line_item_kind" AS ENUM (
  'subscription',
  'addon',
  'discount',
  'tax',
  'proration'
);

-- CreateTable: subscriptions
CREATE TABLE "subscription"."subscriptions" (
  "id"                           TEXT                                          NOT NULL,
  "stripe_subscription_id"       TEXT                                          NOT NULL,
  "stripe_customer_id"           TEXT                                          NOT NULL,
  "customer_id"                  TEXT                                          NOT NULL,
  "customer_group"               "subscription"."plan_customer_group"          NOT NULL,
  "plan_id"                      TEXT                                          NOT NULL,
  "status"                       "subscription"."subscription_status"          NOT NULL,
  "billing_interval"             "subscription"."billing_interval"             NOT NULL,
  "current_period_start"         TIMESTAMPTZ(6)                                NOT NULL,
  "current_period_end"           TIMESTAMPTZ(6)                                NOT NULL,
  "trial_end"                    TIMESTAMPTZ(6),
  "cancel_at_period_end"         BOOLEAN                                       NOT NULL DEFAULT false,
  "cancel_reason"                "subscription"."subscription_cancel_reason",
  "canceled_at"                  TIMESTAMPTZ(6),
  "default_payment_method_id"    TEXT,
  "created_at"                   TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                   TIMESTAMPTZ(6)                                NOT NULL,

  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — unique handle into Stripe
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscription"."subscriptions"("stripe_subscription_id");

-- CreateIndex — hot read path: per-customer dashboard query
CREATE INDEX "subscriptions_customer_status_idx" ON "subscription"."subscriptions"("customer_id", "customer_group", "status");

-- CreateIndex — dunning + admin: "show me everything in past_due" / "what rolls today"
CREATE INDEX "subscriptions_status_period_end_idx" ON "subscription"."subscriptions"("status", "current_period_end");

-- CreateIndex — plan-rollup analytics: "active subs on Tier 2"
CREATE INDEX "subscriptions_plan_status_idx" ON "subscription"."subscriptions"("plan_id", "status");

-- AddForeignKey — plan_id → plans.id (same schema)
ALTER TABLE "subscription"."subscriptions"
  ADD CONSTRAINT "subscriptions_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "subscription"."plans"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: subscription_history (append-only)
CREATE TABLE "subscription"."subscription_history" (
  "id"               TEXT                                          NOT NULL,
  "subscription_id"  TEXT                                          NOT NULL,
  "event"            "subscription"."subscription_history_event"   NOT NULL,
  "from_status"      "subscription"."subscription_status",
  "to_status"        "subscription"."subscription_status",
  "context"          JSONB                                         NOT NULL DEFAULT '{}',
  "actor_user_id"    TEXT,
  "actor_kind"       TEXT                                          NOT NULL,
  "source"           TEXT,
  "occurred_at"      TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "subscription_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — per-subscription chronological scroll
CREATE INDEX "subscription_history_subscription_idx" ON "subscription"."subscription_history"("subscription_id", "occurred_at" DESC);

-- CreateIndex — compliance: per-actor audit
CREATE INDEX "subscription_history_actor_idx" ON "subscription"."subscription_history"("actor_user_id", "occurred_at" DESC);

-- AddForeignKey — subscription_id → subscriptions.id
ALTER TABLE "subscription"."subscription_history"
  ADD CONSTRAINT "subscription_history_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "subscription"."subscriptions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: payment_methods
CREATE TABLE "subscription"."payment_methods" (
  "id"                          TEXT                                          NOT NULL,
  "stripe_payment_method_id"    TEXT                                          NOT NULL,
  "stripe_customer_id"          TEXT                                          NOT NULL,
  "customer_id"                 TEXT                                          NOT NULL,
  "customer_group"              "subscription"."plan_customer_group"          NOT NULL,
  "kind"                        "subscription"."payment_method_kind"          NOT NULL,
  "brand"                       TEXT,
  "last4"                       VARCHAR(4),
  "expiry_month"                INTEGER,
  "expiry_year"                 INTEGER,
  "is_default"                  BOOLEAN                                       NOT NULL DEFAULT false,
  "created_at"                  TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                  TIMESTAMPTZ(6)                                NOT NULL,

  CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — unique Stripe handle
CREATE UNIQUE INDEX "payment_methods_stripe_payment_method_id_key" ON "subscription"."payment_methods"("stripe_payment_method_id");

-- CreateIndex — per-customer list query
CREATE INDEX "payment_methods_customer_idx" ON "subscription"."payment_methods"("customer_id", "customer_group");

-- CreateTable: invoices
CREATE TABLE "subscription"."invoices" (
  "id"                  TEXT                                          NOT NULL,
  "stripe_invoice_id"   TEXT                                          NOT NULL,
  "subscription_id"     TEXT                                          NOT NULL,
  "status"              "subscription"."invoice_status"               NOT NULL,
  "total"               DECIMAL(12,2)                                 NOT NULL,
  "tax"                 DECIMAL(12,2)                                 NOT NULL DEFAULT 0,
  "amount_paid"         DECIMAL(12,2)                                 NOT NULL DEFAULT 0,
  "currency"            CHAR(3)                                       NOT NULL DEFAULT 'USD',
  "issued_at"           TIMESTAMPTZ(6)                                NOT NULL,
  "paid_at"             TIMESTAMPTZ(6),
  "hosted_invoice_url"  TEXT,
  "invoice_pdf_url"     TEXT,
  "created_at"          TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6)                                NOT NULL,

  CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — unique Stripe handle
CREATE UNIQUE INDEX "invoices_stripe_invoice_id_key" ON "subscription"."invoices"("stripe_invoice_id");

-- CreateIndex — per-subscription chronological scroll for billing history
CREATE INDEX "invoices_subscription_issued_idx" ON "subscription"."invoices"("subscription_id", "issued_at" DESC);

-- CreateIndex — dunning + ops: open invoices past due
CREATE INDEX "invoices_status_issued_idx" ON "subscription"."invoices"("status", "issued_at");

-- AddForeignKey — subscription_id → subscriptions.id
ALTER TABLE "subscription"."invoices"
  ADD CONSTRAINT "invoices_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "subscription"."subscriptions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: invoice_line_items
CREATE TABLE "subscription"."invoice_line_items" (
  "id"                    TEXT                                          NOT NULL,
  "invoice_id"            TEXT                                          NOT NULL,
  "stripe_line_item_id"   TEXT                                          NOT NULL,
  "kind"                  "subscription"."invoice_line_item_kind"       NOT NULL,
  "description"           TEXT                                          NOT NULL,
  "amount"                DECIMAL(12,2)                                 NOT NULL,
  "currency"              CHAR(3)                                       NOT NULL DEFAULT 'USD',
  "period_start"          TIMESTAMPTZ(6),
  "period_end"            TIMESTAMPTZ(6),
  "created_at"            TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — unique Stripe handle for replay-safe re-sync
CREATE UNIQUE INDEX "invoice_line_items_stripe_line_item_id_key" ON "subscription"."invoice_line_items"("stripe_line_item_id");

-- CreateIndex — invoice-scoped scroll
CREATE INDEX "invoice_line_items_invoice_idx" ON "subscription"."invoice_line_items"("invoice_id");

-- AddForeignKey — invoice_id → invoices.id
ALTER TABLE "subscription"."invoice_line_items"
  ADD CONSTRAINT "invoice_line_items_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "subscription"."invoices"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
