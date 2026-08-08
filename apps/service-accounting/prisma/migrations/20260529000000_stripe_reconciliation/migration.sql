-- TS-261 — Daily Stripe → ledger reconciliation checkpoint + ops-ticket
-- table: stripe_reconciliation_checks (+ its three enums).
--
-- Adds the derived state the `stripe-reconciliation` worker writes nightly
-- (PRD §10.3, PDD §11.2, CLAUDE.md §6). The reconciliation compares
-- Stripe's reported balance + balance-transaction activity against the
-- platform ledger (the Cash account, `1000`) for a UTC calendar day and
-- records the outcome. No existing table is touched or repurposed — the
-- reconciliation NEVER mutates journals (CLAUDE.md §6 "do not auto-correct
-- silently"); a mismatch lands as a `mismatch_open` row for an operator to
-- triage.
--
-- stripe_reconciliation_checks. One row per (reconciliation_date, category)
-- — the row is BOTH the run checkpoint (always recorded, even when matched)
-- AND the ops ticket (a `mismatch_open` row is an open ticket). The
-- `(reconciliation_date, category)` UNIQUE drives the idempotent re-run
-- upsert: a recompute for the same day refreshes figures + status without
-- duplicating, and preserves a human `mismatch_resolved` decision.
--
-- Money discipline. Every monetary column is DECIMAL(12,2) — never a float
-- (CLAUDE.md §17.6). `expected_amount` (ledger figure), `actual_amount`
-- (Stripe figure), and `delta_amount` may be negative (a payout-heavy day
-- nets the Cash account below zero on the activity dimension); no CHECK
-- defends sign. `actual_amount` / `delta_amount` / `stripe_transaction_count`
-- are NULL in stub mode (no live Stripe query in Phase 1).
--
-- Cross-service references. `resolved_by_user_id` is a soft pointer into
-- `identity.users.id` — cross-schema joins are forbidden (CLAUDE.md §2.3,
-- §4.1). No FK crosses the schema boundary.
--
-- Indexes.
--   - UNIQUE (reconciliation_date, category) — the idempotent upsert key.
--     EXPLAIN: the nightly upsert + any single-day read are an index seek.
--   - (status, reconciliation_date DESC) — the ops-queue read
--     `WHERE status = 'mismatch_open' ORDER BY reconciliation_date DESC`.
--     EXPLAIN: Postgres seeks the status prefix then walks the date suffix
--     backwards (no sort node) for the "open mismatches, newest first" list.
--
-- Forward-compatible: expand-only — no existing column is repurposed.
--
-- Reversal plan:
--   DROP TABLE "accounting"."stripe_reconciliation_checks";
--   DROP TYPE  "accounting"."stripe_reconciliation_mode";
--   DROP TYPE  "accounting"."stripe_reconciliation_status";
--   DROP TYPE  "accounting"."stripe_reconciliation_category";
-- Safe in isolation — no other table references these shapes.

-- CreateEnum
CREATE TYPE "accounting"."stripe_reconciliation_category" AS ENUM ('balance', 'activity');

-- CreateEnum
CREATE TYPE "accounting"."stripe_reconciliation_status" AS ENUM ('matched', 'mismatch_open', 'mismatch_resolved', 'skipped_stub');

-- CreateEnum
CREATE TYPE "accounting"."stripe_reconciliation_mode" AS ENUM ('live', 'stub');

-- CreateTable — one reconciliation check per (UTC date, dimension).
CREATE TABLE "accounting"."stripe_reconciliation_checks" (
  "id"                        TEXT            NOT NULL,
  "reconciliation_date"       DATE            NOT NULL,
  "category"                  "accounting"."stripe_reconciliation_category" NOT NULL,
  "status"                    "accounting"."stripe_reconciliation_status"   NOT NULL,
  "mode"                      "accounting"."stripe_reconciliation_mode"     NOT NULL,
  "currency"                  CHAR(3)         NOT NULL DEFAULT 'USD',
  "expected_amount"          DECIMAL(12,2)   NOT NULL,
  "actual_amount"            DECIMAL(12,2),
  "delta_amount"             DECIMAL(12,2),
  "tolerance_amount"         DECIMAL(12,2)   NOT NULL,
  "stripe_transaction_count" INTEGER,
  "window_start"             TIMESTAMPTZ(6)  NOT NULL,
  "window_end"               TIMESTAMPTZ(6)  NOT NULL,
  "detail"                   TEXT            NOT NULL,
  "computed_at"              TIMESTAMPTZ(6)  NOT NULL,
  "resolved_at"             TIMESTAMPTZ(6),
  "resolved_by_user_id"     TEXT,
  "resolution_notes"        TEXT,
  "created_at"               TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMPTZ(6)  NOT NULL,

  CONSTRAINT "stripe_reconciliation_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — one row per (day, dimension). Drives the idempotent
-- re-run upsert + single-day reads.
CREATE UNIQUE INDEX "stripe_reconciliation_checks_date_category_unique"
  ON "accounting"."stripe_reconciliation_checks"("reconciliation_date", "category");

-- CreateIndex — the ops-queue read: open mismatches, newest first.
CREATE INDEX "stripe_reconciliation_checks_status_date_idx"
  ON "accounting"."stripe_reconciliation_checks"("status", "reconciliation_date" DESC);
