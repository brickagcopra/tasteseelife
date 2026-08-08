-- TS-085 — period close + reopen workflow: period_lifecycle_events table.
--
-- Captures every `open → closed` and `closed → open` transition on an
-- accounting period (CLAUDE.md §6: "Reopen is audit-logged"; PDD §11.2:
-- "Period close locks journal entries; off-period adjustments require
-- explicit reopen (audited)").
--
-- Why a separate audit table when `AccountingPeriod.closed_at` /
-- `closed_by_user_id` already exist:
--   - Those columns are the MOST RECENT close only — a re-close
--     overwrites them. The TS-080 schema header comment is explicit
--     about that: "Reopens DO NOT clear them — the close happened, and
--     the audit record is preserved. A subsequent re-close overwrites
--     with the new timestamp."
--   - The events table preserves EVERY transition, so the finance
--     audit trail covers the full lifecycle. Until TS-100 audit-svc
--     (Cassandra cold) lands, this table IS the canonical audit
--     record for period lifecycle.
--   - Per-event idempotency on `source_event_id` UNIQUE: an admin
--     double-click on "close period" surfaces the same event row,
--     not a duplicate.
--
-- Forward-compatible: expand-only — no existing column is repurposed.
-- `AccountingPeriod` is untouched at the column level; the new model
-- adds a Prisma back-relation but no DDL change on the existing table.
--
-- Reversal plan:
--   DROP TABLE  "accounting"."period_lifecycle_events";
--   DROP TYPE   "accounting"."period_lifecycle_event_kind";
-- Safe in isolation — no other table references the new shape.

-- CreateEnum — kind of lifecycle transition.
CREATE TYPE "accounting"."period_lifecycle_event_kind" AS ENUM (
  'close',
  'reopen'
);

-- CreateTable — period_lifecycle_events. One row per close/reopen.
CREATE TABLE "accounting"."period_lifecycle_events" (
  "id"                  TEXT                                            NOT NULL,
  "period_id"           TEXT                                            NOT NULL,
  "kind"                "accounting"."period_lifecycle_event_kind"      NOT NULL,
  "actor_user_id"       TEXT                                            NOT NULL,
  "source_event_id"     TEXT                                            NOT NULL,
  "reason_code"         TEXT                                            NOT NULL,
  "description"         TEXT,
  "occurred_at"         TIMESTAMPTZ(6)                                  NOT NULL,
  "created_at"          TIMESTAMPTZ(6)                                  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "period_lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey — period_id → accounting_periods(id). Both tables live
-- in the `accounting` schema so a real FK is allowed (cross-schema FKs
-- are forbidden, CLAUDE.md §4.1).
ALTER TABLE "accounting"."period_lifecycle_events"
  ADD CONSTRAINT "period_lifecycle_events_period_id_fkey"
  FOREIGN KEY ("period_id")
  REFERENCES "accounting"."accounting_periods"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- CreateIndex — source_event_id UNIQUE. Admin double-click /
-- redelivery squashes to a single audit event. The PeriodLifecycle
-- service catches the P2002 and returns the cached row.
CREATE UNIQUE INDEX "period_lifecycle_events_source_event_id_key"
  ON "accounting"."period_lifecycle_events"("source_event_id");

-- CreateIndex — per-period chronological scroll. "Show me every close
-- and reopen of period 2026-05, newest first" — the dominant audit
-- query.
CREATE INDEX "period_lifecycle_events_period_idx"
  ON "accounting"."period_lifecycle_events"("period_id", "occurred_at" DESC);

-- CreateIndex — per-actor audit roll-up. "Every period that this user
-- closed or reopened". Finance staff review.
CREATE INDEX "period_lifecycle_events_actor_idx"
  ON "accounting"."period_lifecycle_events"("actor_user_id", "occurred_at" DESC);
