-- TS-090 — initial payouts schema.
--
-- Creates the `payouts` Postgres schema, the `payout_account_status`
-- enum, the three core tables (provider_payout_accounts +
-- payout_account_link_events + stripe_account_events), and the
-- supporting indexes + triggers.
--
-- Reversal plan:
--   DROP TABLE "payouts"."stripe_account_events";
--   DROP TABLE "payouts"."payout_account_link_events";
--   DROP TRIGGER "provider_payout_accounts_no_rebind" ON "payouts"."provider_payout_accounts";
--   DROP FUNCTION "payouts"."provider_payout_accounts_no_rebind"();
--   DROP TABLE "payouts"."provider_payout_accounts";
--   DROP TYPE  "payouts"."payout_account_status";
--   DROP SCHEMA "payouts";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Forward-compatible: subsequent migrations add (never repurpose) per
-- CLAUDE.md §4.1.

CREATE SCHEMA IF NOT EXISTS "payouts";

-- CreateEnum
CREATE TYPE "payouts"."payout_account_status" AS ENUM (
  'pending_onboarding',
  'restricted',
  'active',
  'disabled'
);

-- CreateTable: provider_payout_accounts
--
-- One row per provider × Stripe Connect Express account. `provider_id`
-- and `stripe_account_id` are both UNIQUE so the create path can rely
-- on either constraint for idempotency.
CREATE TABLE "payouts"."provider_payout_accounts" (
  "id"                            TEXT                                NOT NULL,
  "provider_id"                   TEXT                                NOT NULL,
  "stripe_account_id"             TEXT                                NOT NULL,
  "country"                       TEXT                                NOT NULL,
  "default_currency"              TEXT                                NOT NULL,
  "status"                        "payouts"."payout_account_status"   NOT NULL,
  "charges_enabled"               BOOLEAN                             NOT NULL DEFAULT FALSE,
  "payouts_enabled"               BOOLEAN                             NOT NULL DEFAULT FALSE,
  "details_submitted"             BOOLEAN                             NOT NULL DEFAULT FALSE,
  "requirements_currently_due"    JSONB                               NOT NULL DEFAULT '[]'::jsonb,
  "requirements_past_due"         JSONB                               NOT NULL DEFAULT '[]'::jsonb,
  "disabled_reason"               TEXT,
  "live_mode"                     BOOLEAN                             NOT NULL DEFAULT FALSE,
  "created_at"                    TIMESTAMPTZ(6)                      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                    TIMESTAMPTZ(6)                      NOT NULL,

  CONSTRAINT "provider_payout_accounts_pkey" PRIMARY KEY ("id")
);

-- UNIQUE on provider_id — one Stripe Connect Express account per
-- provider. The create flow relies on this constraint as the canonical
-- dedup mechanism.
CREATE UNIQUE INDEX "provider_payout_accounts_provider_id_key"
  ON "payouts"."provider_payout_accounts"("provider_id");

-- UNIQUE on stripe_account_id — Stripe ids are globally unique within
-- our Stripe account; the stub generator deterministically derives the
-- id from the surrogate id so collisions are impossible.
CREATE UNIQUE INDEX "provider_payout_accounts_stripe_account_id_key"
  ON "payouts"."provider_payout_accounts"("stripe_account_id");

-- Powers the admin "list accounts in a given onboarding state" filter
-- — surfaces providers stuck in `restricted` or `pending_onboarding`.
CREATE INDEX "payout_accounts_status_created_idx"
  ON "payouts"."provider_payout_accounts"("status", "created_at" DESC);

-- Defence-in-depth against a regression that rebinds an account to a
-- different provider (which would corrupt every downstream payout).
-- The trigger raises on any UPDATE that changes either `provider_id`
-- or `stripe_account_id`. Service-layer code never UPDATEs these
-- columns; admin tooling that needs to remap (e.g. a Stripe Connect
-- account merge) must DROP TRIGGER + apply the change + recreate.
CREATE OR REPLACE FUNCTION "payouts"."provider_payout_accounts_no_rebind"()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.provider_id IS DISTINCT FROM OLD.provider_id THEN
    RAISE EXCEPTION
      'provider_payout_accounts.provider_id is immutable after create (CLAUDE.md §6)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.stripe_account_id IS DISTINCT FROM OLD.stripe_account_id THEN
    RAISE EXCEPTION
      'provider_payout_accounts.stripe_account_id is immutable after create (CLAUDE.md §6)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_payout_accounts_no_rebind"
  BEFORE UPDATE ON "payouts"."provider_payout_accounts"
  FOR EACH ROW
  EXECUTE FUNCTION "payouts"."provider_payout_accounts_no_rebind"();

-- CreateTable: payout_account_link_events
--
-- Audit trail of every Stripe account-link the platform has minted.
-- Append-only by service-layer convention; the migration does NOT
-- install a no-mutation trigger because operationally we may need to
-- correct a malformed row (e.g. URL truncation bug). The audit-trail
-- semantics are enforced at the service-layer.
CREATE TABLE "payouts"."payout_account_link_events" (
  "id"                            TEXT            NOT NULL,
  "provider_payout_account_id"    TEXT            NOT NULL,
  "kind"                          TEXT            NOT NULL,
  "url"                           TEXT            NOT NULL,
  "expires_at"                    TIMESTAMPTZ(6)  NOT NULL,
  "live_mode"                     BOOLEAN         NOT NULL DEFAULT FALSE,
  "created_at"                    TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "payout_account_link_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payout_account_link_events_account_fkey"
    FOREIGN KEY ("provider_payout_account_id")
    REFERENCES "payouts"."provider_payout_accounts"("id")
    ON DELETE CASCADE
);

CREATE INDEX "payout_link_events_account_created_idx"
  ON "payouts"."payout_account_link_events"("provider_payout_account_id", "created_at" DESC);

-- CreateTable: stripe_account_events
--
-- Idempotent ingest log of Stripe `account.*` webhook events. The
-- UNIQUE on `stripe_event_id` is the dedup key — a retried delivery
-- (from Stripe directly or from service-webhook) replays into the
-- existing row.
CREATE TABLE "payouts"."stripe_account_events" (
  "id"                            TEXT            NOT NULL,
  "stripe_event_id"               TEXT            NOT NULL,
  "event_type"                    TEXT            NOT NULL,
  "stripe_account_id"             TEXT            NOT NULL,
  "provider_payout_account_id"    TEXT,
  "occurred_at"                   TIMESTAMPTZ(6)  NOT NULL,
  "payload"                       JSONB           NOT NULL,
  "outcome"                       TEXT            NOT NULL,
  "created_at"                    TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stripe_account_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stripe_account_events_account_fkey"
    FOREIGN KEY ("provider_payout_account_id")
    REFERENCES "payouts"."provider_payout_accounts"("id")
    ON DELETE SET NULL
);

CREATE UNIQUE INDEX "stripe_account_events_stripe_event_id_key"
  ON "payouts"."stripe_account_events"("stripe_event_id");

-- Powers "every event for this Stripe account, newest first" — the
-- admin troubleshooting view.
CREATE INDEX "stripe_account_events_account_occurred_idx"
  ON "payouts"."stripe_account_events"("stripe_account_id", "occurred_at" DESC);
