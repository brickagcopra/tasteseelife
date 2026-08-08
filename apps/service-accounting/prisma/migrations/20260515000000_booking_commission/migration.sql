-- TS-083 — booking commission ledger: provider_payable_balances table.
--
-- Adds the per-provider running-balance row that the booking-commission
-- recognizer keeps in step with the immutable journal-line ledger.
--
-- Why this table exists. The booking-completion journal credits
-- `2100 Provider Payable` (a liability) with the provider's portion of
-- the gross commission. To answer "what does the platform owe provider
-- X right now?" without scanning every journal line, we maintain a
-- materialised running balance row per (provider, currency). The row
-- moves in lockstep with the ledger:
--
--   - booking completion (TS-083) → `amount += providerPortion` AND
--                                     a balanced DR Cash / CR
--                                     Marketplace Revenue + DR Contra /
--                                     CR Provider Payable journal lands.
--   - provider payout disbursement (TS-090 / TS-091) → `amount -=
--                                     payoutAmount` AND a DR Provider
--                                     Payable / CR Cash journal lands
--                                     on Stripe transfer success.
--   - refund post-payout (TS-084) → balance can briefly go negative
--                                     (the provider owes US the
--                                     reclaimed amount); no CHECK
--                                     constraint here so the refund
--                                     path doesn't fight the schema.
--
-- One row per (provider, currency). The composite UNIQUE supports the
-- upsert-on-completion contract; the per-provider index covers the
-- dominant admin/payouts read pattern (`SELECT * FROM
-- provider_payable_balances WHERE provider_id = $1`).
--
-- No CHECK constraint on `amount`. A naive "amount >= 0" would defend
-- against negative balances in the happy path, but TS-084's
-- refund-after-payout flow legitimately drives the balance negative
-- (clawback). Application-layer logic handles the negative-balance
-- ops queue; the DB stays out of the way.
--
-- Cross-service references. `provider_id` is a soft pointer into
-- `provider.providers.id` — cross-schema joins are forbidden
-- (CLAUDE.md §2.3, §4.1). The gateway aggregates when a view needs
-- the provider's display name alongside the running balance.
--
-- Forward-compatible: expand-only — no existing column is repurposed.
-- The TS-080 init migration's tables are untouched.
--
-- Reversal plan:
--   DROP TABLE "accounting"."provider_payable_balances";
-- Safe in isolation — no other table references this shape.

-- CreateTable — per-(provider, currency) running balance row.
CREATE TABLE "accounting"."provider_payable_balances" (
  "id"               TEXT            NOT NULL,
  "provider_id"      TEXT            NOT NULL,
  "currency"         CHAR(3)         NOT NULL DEFAULT 'USD',
  "amount"           DECIMAL(12,2)   NOT NULL DEFAULT 0,
  "last_updated_at"  TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"       TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(6)  NOT NULL,

  CONSTRAINT "provider_payable_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — one row per (provider, currency). The upsert path
-- relies on this for the conflict target; cross-currency rows live
-- on separate rows.
CREATE UNIQUE INDEX "provider_payable_balances_provider_currency_unique"
  ON "accounting"."provider_payable_balances"("provider_id", "currency");

-- CreateIndex — per-provider scroll. The dominant admin "show me
-- the outstanding payable balance for this provider" + the payouts
-- worker's "every provider with a non-zero balance above the payout
-- threshold" query.
CREATE INDEX "provider_payable_balances_provider_idx"
  ON "accounting"."provider_payable_balances"("provider_id");
