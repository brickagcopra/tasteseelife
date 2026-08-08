-- TS-091 — Payouts: T+2 disbursement schedule + provider payable balances.
--
-- Adds the `payout_disbursements` table + `payout_disbursement_status`
-- enum + the BEFORE-UPDATE trigger that protects the stripe_transfer_id
-- column from a rebind.
--
-- Forward-compatible expand migration (CLAUDE.md §4.1, §4.4). Reversal
-- plan:
--   DROP TRIGGER "payout_disbursements_no_rebind" ON "payouts"."payout_disbursements";
--   DROP FUNCTION "payouts"."payout_disbursements_no_rebind"();
--   DROP TABLE "payouts"."payout_disbursements";
--   DROP TYPE  "payouts"."payout_disbursement_status";
-- Safe in isolation — no other table references these objects.

-- CreateEnum
CREATE TYPE "payouts"."payout_disbursement_status" AS ENUM (
  'pending',
  'in_transit',
  'paid',
  'failed',
  'canceled'
);

-- CreateTable: payout_disbursements
--
-- One row per attempted (or planned) disbursement from the platform to
-- a provider's Stripe Connect Express account. Two service-managed
-- dedup keys (`idempotency_key`, `source_event_id`) are UNIQUE at the
-- DB layer; the immutability trigger below protects stripe_transfer_id
-- from a rebind once set.
CREATE TABLE "payouts"."payout_disbursements" (
  "id"                  TEXT                                  NOT NULL,
  "provider_id"         TEXT                                  NOT NULL,
  "stripe_account_id"   TEXT                                  NOT NULL,
  "stripe_transfer_id"  TEXT,
  "currency"            TEXT                                  NOT NULL,
  "amount_minor"        BIGINT                                NOT NULL,
  "idempotency_key"     TEXT                                  NOT NULL,
  "source_event_id"     TEXT                                  NOT NULL,
  "scheduled_for"       DATE                                  NOT NULL,
  "held_until"          TIMESTAMPTZ(6)                        NOT NULL,
  "initiated_at"        TIMESTAMPTZ(6),
  "paid_at"             TIMESTAMPTZ(6),
  "failed_at"           TIMESTAMPTZ(6),
  "failure_reason"      TEXT,
  "memo"                TEXT,
  "status"              "payouts"."payout_disbursement_status" NOT NULL,
  "live_mode"           BOOLEAN                               NOT NULL DEFAULT FALSE,
  "created_at"          TIMESTAMPTZ(6)                        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6)                        NOT NULL,

  CONSTRAINT "payout_disbursements_pkey" PRIMARY KEY ("id"),

  -- Money invariants — defence in depth against bad service-layer code.
  CONSTRAINT "payout_disbursements_amount_positive_chk"
    CHECK ("amount_minor" > 0),

  -- Per-status timestamp invariants. Encodes the "paid → paid_at NOT
  -- NULL", "failed → failed_at + failure_reason NOT NULL", "pending →
  -- everything terminal-null" disjoint-branches contract.
  CONSTRAINT "payout_disbursements_status_invariants_chk"
    CHECK (
      ("status" = 'pending'    AND "initiated_at" IS NULL  AND "paid_at" IS NULL AND "failed_at" IS NULL)
      OR ("status" = 'in_transit' AND "initiated_at" IS NOT NULL AND "paid_at" IS NULL AND "failed_at" IS NULL)
      OR ("status" = 'paid'       AND "initiated_at" IS NOT NULL AND "paid_at" IS NOT NULL AND "failed_at" IS NULL)
      OR ("status" = 'failed'     AND "failed_at" IS NOT NULL AND "failure_reason" IS NOT NULL)
      OR ("status" = 'canceled'   AND "paid_at" IS NULL)
    )
);

-- Service-managed dedup key.
CREATE UNIQUE INDEX "payout_disbursements_idempotency_key_key"
  ON "payouts"."payout_disbursements"("idempotency_key");

-- Accounting-postback dedup key.
CREATE UNIQUE INDEX "payout_disbursements_source_event_id_key"
  ON "payouts"."payout_disbursements"("source_event_id");

-- Stripe-supplied transfer id. UNIQUE so a duplicate transfer-event
-- ingest cannot link to two different disbursement rows. Nullable —
-- pending rows have no transfer id yet.
CREATE UNIQUE INDEX "payout_disbursements_stripe_transfer_id_key"
  ON "payouts"."payout_disbursements"("stripe_transfer_id");

-- Per-provider history scroll, newest first.
CREATE INDEX "payout_disbursements_provider_created_idx"
  ON "payouts"."payout_disbursements"("provider_id", "created_at" DESC);

-- Admin "stuck pending" + status filter view.
CREATE INDEX "payout_disbursements_status_created_idx"
  ON "payouts"."payout_disbursements"("status", "created_at" DESC);

-- Reporting roll-ups by scheduled-for date.
CREATE INDEX "payout_disbursements_scheduled_for_idx"
  ON "payouts"."payout_disbursements"("scheduled_for");

-- Trigger function: enforce `stripe_transfer_id` immutability once set.
--
-- The disbursement row's stripe_transfer_id is assigned ONCE when the
-- Stripe Transfer call lands. A regression that rebinds it to a
-- different Stripe Transfer id would corrupt the operator audit trail
-- + the eventual 1099-NEC accumulation. Service-layer code never
-- rebinds; the trigger raises SQLSTATE 42501 on any attempt.
--
-- Allowed transitions on this column: NULL → 'tr_xxx' (initial assign);
-- value → same value (idempotent UPDATE harmless). DISALLOWED: NULL →
-- another NULL of different type (no-op anyway); value → NULL; value
-- → different value.
--
-- Admin tooling that needs to remap (e.g. a Stripe support-issued
-- replacement transfer id) must DROP TRIGGER + apply + recreate.
CREATE OR REPLACE FUNCTION "payouts"."payout_disbursements_no_rebind"()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.stripe_transfer_id IS NOT NULL
     AND NEW.stripe_transfer_id IS DISTINCT FROM OLD.stripe_transfer_id THEN
    RAISE EXCEPTION
      'payout_disbursements.stripe_transfer_id is immutable after assignment (CLAUDE.md §6)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.provider_id IS DISTINCT FROM OLD.provider_id THEN
    RAISE EXCEPTION
      'payout_disbursements.provider_id is immutable after create (CLAUDE.md §6)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION
      'payout_disbursements.idempotency_key is immutable after create (CLAUDE.md §6)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.source_event_id IS DISTINCT FROM OLD.source_event_id THEN
    RAISE EXCEPTION
      'payout_disbursements.source_event_id is immutable after create (CLAUDE.md §6)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payout_disbursements_no_rebind"
  BEFORE UPDATE ON "payouts"."payout_disbursements"
  FOR EACH ROW
  EXECUTE FUNCTION "payouts"."payout_disbursements_no_rebind"();
