-- TS-080 — initial accounting schema.
--
-- Creates the `accounting` Postgres schema and the four core tables of
-- the double-entry ledger:
--
--   - chart_of_accounts(id, code, name, type, parent_id, normal_balance,
--                       currency, active, ...) — hierarchical chart.
--   - accounting_periods(id, name, start_date, end_date, status, ...) —
--                       open/closed period envelope.
--   - journals(id, kind, occurred_at, source_event_id, period_id, ...) —
--                       immutable, balanced transaction envelope.
--   - journal_lines(id, journal_id, account_id, debit, credit, ...) —
--                       the per-side detail rows.
--
-- The double-entry posting service (TS-081), revenue-recognition driver
-- (TS-082), booking-commission entries (TS-083), coupon contra-revenue +
-- refund reversals (TS-084), and period close (TS-085) land as
-- expand-only follow-ups. The skeleton ships only the catalog + the
-- read-only listing endpoint; no live write paths beyond the idempotent
-- seed.
--
-- Forward-compatible: subsequent migrations add (never repurpose) per
-- CLAUDE.md §4.1 and §5.3 (events also evolve additively).
--
-- Reversal plan:
--   DROP TABLE "accounting"."journal_lines";
--   DROP TABLE "accounting"."journals";
--   DROP TABLE "accounting"."accounting_periods";
--   DROP TABLE "accounting"."chart_of_accounts";
--   DROP TYPE  "accounting"."journal_kind";
--   DROP TYPE  "accounting"."period_status";
--   DROP TYPE  "accounting"."account_normal_balance";
--   DROP TYPE  "accounting"."account_type";
--   DROP SCHEMA "accounting";
-- Safe in isolation because no other service schema references these
-- tables (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-accounting prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "accounting";

-- CreateEnum — account category (asset/liability/equity/revenue/contra/expense)
CREATE TYPE "accounting"."account_type" AS ENUM (
  'asset',
  'liability',
  'equity',
  'revenue',
  'contra_revenue',
  'expense'
);

-- CreateEnum — the "natural" side that increases the account's balance.
CREATE TYPE "accounting"."account_normal_balance" AS ENUM (
  'debit',
  'credit'
);

-- CreateEnum — period lifecycle gate for TS-081 post acceptance.
CREATE TYPE "accounting"."period_status" AS ENUM (
  'open',
  'closed'
);

-- CreateEnum — categorical journal kind (drives per-category report
-- roll-ups + per-event-source filtering on TS-129 admin journal browser).
CREATE TYPE "accounting"."journal_kind" AS ENUM (
  'subscription_activation',
  'subscription_recognition',
  'subscription_cancellation',
  'booking_completion',
  'provider_payout',
  'refund',
  'coupon_redemption',
  'payment_processing_fee',
  'manual_adjustment',
  'period_close',
  'reversal'
);

-- CreateTable — chart of accounts (hierarchical via parent_id self-FK).
CREATE TABLE "accounting"."chart_of_accounts" (
  "id"              TEXT                                          NOT NULL,
  "code"            TEXT                                          NOT NULL,
  "name"            TEXT                                          NOT NULL,
  "description"     TEXT,
  "type"            "accounting"."account_type"                   NOT NULL,
  "parent_id"       TEXT,
  "normal_balance"  "accounting"."account_normal_balance"         NOT NULL,
  "currency"        CHAR(3)                                       NOT NULL DEFAULT 'USD',
  "active"          BOOLEAN                                       NOT NULL DEFAULT true,
  "created_at"      TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(6)                                NOT NULL,

  CONSTRAINT "chart_of_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — `code` is the stable accounting identifier referenced
-- in reports + audit trails + accounting exports. UNIQUE.
CREATE UNIQUE INDEX "chart_of_accounts_code_key"
  ON "accounting"."chart_of_accounts"("code");

-- CreateIndex — admin ledger view: WHERE active = true ORDER BY code.
CREATE INDEX "chart_of_accounts_active_code_idx"
  ON "accounting"."chart_of_accounts"("active", "code");

-- CreateIndex — sub-account drilldown: WHERE parent_id = $1 ORDER BY code.
CREATE INDEX "chart_of_accounts_parent_idx"
  ON "accounting"."chart_of_accounts"("parent_id", "code");

-- CreateIndex — type-filtered roll-up: WHERE type = $1 AND active = true.
CREATE INDEX "chart_of_accounts_type_active_idx"
  ON "accounting"."chart_of_accounts"("type", "active", "code");

-- AddForeignKey — self-FK for the chart hierarchy. ON DELETE RESTRICT
-- because we never delete accounts; admin tooling toggles `active=false`.
ALTER TABLE "accounting"."chart_of_accounts"
  ADD CONSTRAINT "chart_of_accounts_parent_id_fkey"
  FOREIGN KEY ("parent_id")
  REFERENCES "accounting"."chart_of_accounts"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- CreateTable — accounting periods (calendar-agnostic open/closed envelope).
CREATE TABLE "accounting"."accounting_periods" (
  "id"                  TEXT                                NOT NULL,
  "name"                TEXT                                NOT NULL,
  "start_date"          DATE                                NOT NULL,
  "end_date"            DATE                                NOT NULL,
  "status"              "accounting"."period_status"        NOT NULL DEFAULT 'open',
  "closed_at"           TIMESTAMPTZ(6),
  "closed_by_user_id"   TEXT,
  "created_at"          TIMESTAMPTZ(6)                      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6)                      NOT NULL,

  CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — `name` is the human-readable period identifier
-- (`2026-05`, `2026-Q2`). UNIQUE.
CREATE UNIQUE INDEX "accounting_periods_name_key"
  ON "accounting"."accounting_periods"("name");

-- CreateIndex — admin period-management view: ORDER BY start_date DESC.
CREATE INDEX "accounting_periods_start_desc_idx"
  ON "accounting"."accounting_periods"("start_date" DESC);

-- CreateIndex — TS-081 post-acceptance guard: WHERE status = 'open' AND
-- start_date <= occurred_at::date AND end_date >= occurred_at::date.
CREATE INDEX "accounting_periods_status_range_idx"
  ON "accounting"."accounting_periods"("status", "start_date", "end_date");

-- CreateTable — journals (immutable, balanced transaction envelope).
CREATE TABLE "accounting"."journals" (
  "id"                       TEXT                              NOT NULL,
  "kind"                     "accounting"."journal_kind"       NOT NULL,
  "occurred_at"              TIMESTAMPTZ(6)                    NOT NULL,
  "source_event_id"          TEXT                              NOT NULL,
  "description"              TEXT                              NOT NULL,
  "posted_at"                TIMESTAMPTZ(6)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversed_by_journal_id"   TEXT,
  "reversed_journal_id"      TEXT,
  "posted_by_user_id"        TEXT,
  "period_id"                TEXT                              NOT NULL,
  "context"                  JSONB                             NOT NULL DEFAULT '{}',

  CONSTRAINT "journals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — `source_event_id` UNIQUE: the relay's at-least-once
-- delivery is squashed to exactly-once posting at the DB layer.
CREATE UNIQUE INDEX "journals_source_event_id_key"
  ON "accounting"."journals"("source_event_id");

-- CreateIndex — per-period chronological scroll.
CREATE INDEX "journals_period_occurred_idx"
  ON "accounting"."journals"("period_id", "occurred_at" DESC);

-- CreateIndex — per-kind roll-up.
CREATE INDEX "journals_kind_occurred_idx"
  ON "accounting"."journals"("kind", "occurred_at" DESC);

-- CreateIndex — reversal lookup.
CREATE INDEX "journals_reversed_idx"
  ON "accounting"."journals"("reversed_journal_id");

-- AddForeignKey — period membership. ON DELETE RESTRICT because
-- periods are never deleted; closed-period correction goes via reopen +
-- replacement journal.
ALTER TABLE "accounting"."journals"
  ADD CONSTRAINT "journals_period_id_fkey"
  FOREIGN KEY ("period_id")
  REFERENCES "accounting"."accounting_periods"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- CreateTable — journal lines (the per-side detail rows).
CREATE TABLE "accounting"."journal_lines" (
  "id"           TEXT             NOT NULL,
  "journal_id"   TEXT             NOT NULL,
  "account_id"   TEXT             NOT NULL,
  "debit"        DECIMAL(12,2)    NOT NULL DEFAULT 0,
  "credit"       DECIMAL(12,2)    NOT NULL DEFAULT 0,
  "currency"     CHAR(3)          NOT NULL DEFAULT 'USD',
  "memo"         TEXT,
  "created_at"   TIMESTAMPTZ(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — per-journal scroll (display the two-or-more lines of one
-- journal).
CREATE INDEX "journal_lines_journal_idx"
  ON "accounting"."journal_lines"("journal_id");

-- CreateIndex — per-account scroll: "every line against Cash" or "every
-- line against Subscription Revenue Tier 2". Composite covers the
-- typical "this account in this period" filter (join through journals).
CREATE INDEX "journal_lines_account_journal_idx"
  ON "accounting"."journal_lines"("account_id", "journal_id");

-- AddCheckConstraint — exactly one of (debit, credit) is non-zero. The
-- TS-081 JournalPostingService enforces this at the service layer with
-- a transactional abort; the DB-level guard defends against ad-hoc
-- inserts (admin REPL, migrations, future bulk-import tools).
ALTER TABLE "accounting"."journal_lines"
  ADD CONSTRAINT "journal_lines_debit_or_credit_only"
  CHECK (
    ("debit" = 0 AND "credit" > 0)
    OR ("debit" > 0 AND "credit" = 0)
  );

-- AddCheckConstraint — both sides non-negative. Catches a sign error
-- before it lands in the ledger.
ALTER TABLE "accounting"."journal_lines"
  ADD CONSTRAINT "journal_lines_non_negative"
  CHECK ("debit" >= 0 AND "credit" >= 0);

-- AddForeignKey — journal membership. ON DELETE RESTRICT because
-- journals are immutable; lines never orphan a journal envelope.
ALTER TABLE "accounting"."journal_lines"
  ADD CONSTRAINT "journal_lines_journal_id_fkey"
  FOREIGN KEY ("journal_id")
  REFERENCES "accounting"."journals"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- AddForeignKey — account membership. ON DELETE RESTRICT because
-- accounts are never deleted (`active=false` is the retire mechanism).
ALTER TABLE "accounting"."journal_lines"
  ADD CONSTRAINT "journal_lines_account_id_fkey"
  FOREIGN KEY ("account_id")
  REFERENCES "accounting"."chart_of_accounts"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
