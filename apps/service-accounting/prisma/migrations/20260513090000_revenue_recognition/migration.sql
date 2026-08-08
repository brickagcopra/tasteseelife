-- TS-082 — revenue recognition: deferred_revenue_balances + enums.
--
-- Adds the per-subscription amortisation working state. The
-- subscription-side activation journal credits Deferred Revenue (a
-- liability per chart 2000); the daily-recognition driver reads THIS
-- table to compute the next-day amortisation against Subscription
-- Revenue (chart 4000). Subscription revenue is recognised over the
-- service period (CLAUDE.md §17.17 — never on payment); the table is
-- the working state of the amortisation, separate from the immutable
-- journal-line ledger.
--
-- One row per (subscription, service period). A renewal creates a NEW
-- row with a later `service_period_start`; the composite UNIQUE
-- enforces this. Activation event redelivery squashes via the
-- `source_event_id` UNIQUE.
--
-- Forward-compatible: expand-only — no existing column is repurposed.
-- New indexes serve the daily-sweep filter (status + period start) and
-- the per-plan analytics roll-up.
--
-- Reversal plan:
--   DROP TABLE  "accounting"."deferred_revenue_balances";
--   DROP TYPE   "accounting"."deferred_revenue_status";
--   DROP TYPE   "accounting"."deferred_revenue_customer_group";
-- Safe in isolation — no other table references the new shape.

-- CreateEnum — customer group (mirror of subscription.plan_customer_group;
-- cross-service Prisma references are forbidden — CLAUDE.md §2.3).
CREATE TYPE "accounting"."deferred_revenue_customer_group" AS ENUM (
  'family',
  'provider',
  'academy'
);

-- CreateEnum — lifecycle status of a deferred-revenue balance.
CREATE TYPE "accounting"."deferred_revenue_status" AS ENUM (
  'active',
  'fully_recognized',
  'canceled'
);

-- CreateTable — per-subscription deferred-revenue balance.
CREATE TABLE "accounting"."deferred_revenue_balances" (
  "id"                       TEXT                                                NOT NULL,
  "subscription_id"          TEXT                                                NOT NULL,
  "customer_id"              TEXT                                                NOT NULL,
  "customer_group"           "accounting"."deferred_revenue_customer_group"      NOT NULL,
  "plan_code"                TEXT                                                NOT NULL,
  "original_amount"          DECIMAL(12,2)                                       NOT NULL,
  "recognized_amount"        DECIMAL(12,2)                                       NOT NULL DEFAULT 0,
  "currency"                 CHAR(3)                                             NOT NULL DEFAULT 'USD',
  "service_period_start"     TIMESTAMPTZ(6)                                      NOT NULL,
  "service_period_end"       TIMESTAMPTZ(6)                                      NOT NULL,
  "last_recognized_at"       TIMESTAMPTZ(6),
  "status"                   "accounting"."deferred_revenue_status"              NOT NULL DEFAULT 'active',
  "activation_journal_id"    TEXT                                                NOT NULL,
  "source_event_id"          TEXT                                                NOT NULL,
  "context"                  JSONB                                               NOT NULL DEFAULT '{}',
  "created_at"               TIMESTAMPTZ(6)                                      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMPTZ(6)                                      NOT NULL,

  CONSTRAINT "deferred_revenue_balances_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraint — money columns non-negative + recognised <= original.
-- The recognizer service enforces this at the application layer; the
-- DB-level guard defends against ad-hoc updates (admin REPL, future
-- bulk-import tools).
ALTER TABLE "accounting"."deferred_revenue_balances"
  ADD CONSTRAINT "deferred_revenue_balances_amounts_non_negative"
  CHECK ("original_amount" >= 0 AND "recognized_amount" >= 0);

ALTER TABLE "accounting"."deferred_revenue_balances"
  ADD CONSTRAINT "deferred_revenue_balances_recognized_bounded"
  CHECK ("recognized_amount" <= "original_amount");

ALTER TABLE "accounting"."deferred_revenue_balances"
  ADD CONSTRAINT "deferred_revenue_balances_period_ordered"
  CHECK ("service_period_start" <= "service_period_end");

-- CreateIndex — source_event_id UNIQUE: activation event redelivery
-- squashes to a single balance row.
CREATE UNIQUE INDEX "deferred_revenue_balances_source_event_id_key"
  ON "accounting"."deferred_revenue_balances"("source_event_id");

-- CreateIndex — one balance per (subscription, service period start).
-- A renewal creates a new row with a later service_period_start.
CREATE UNIQUE INDEX "deferred_revenue_balances_subscription_period_unique"
  ON "accounting"."deferred_revenue_balances"("subscription_id", "service_period_start");

-- CreateIndex — per-subscription scroll: every balance newest-first.
CREATE INDEX "deferred_revenue_balances_subscription_idx"
  ON "accounting"."deferred_revenue_balances"("subscription_id", "service_period_start" DESC);

-- CreateIndex — daily-sweep filter: WHERE status = 'active' AND
-- service_period_start <= now(). At steady state most rows are
-- `fully_recognized` so the status prefix narrows hard.
CREATE INDEX "deferred_revenue_balances_status_period_idx"
  ON "accounting"."deferred_revenue_balances"("status", "service_period_start");

-- CreateIndex — per-plan roll-up for analytics: "remaining Deferred
-- Revenue by plan tier".
CREATE INDEX "deferred_revenue_balances_plan_status_idx"
  ON "accounting"."deferred_revenue_balances"("plan_code", "status");
