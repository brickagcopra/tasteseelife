-- TS-026 — KYC schema: KycProvider + KycStatus enums + KycRecord table
-- (PDD §8.2 `kyc_records`, §11.1 Stripe Identity for provider KYC light;
-- CLAUDE.md §3.1 / §3.5).
--
-- Forward-compatible expand-only migration. Two new enums and one new
-- table inside the existing `identity` schema. No changes to any
-- previously-existing table (`users`, `refresh_tokens`, `mfa_methods`,
-- `mfa_challenges`, `permissions`, `roles`, `role_permissions`,
-- `user_roles`).
--
-- Reversal plan: drop in reverse-creation order so the indexes unwind
-- cleanly before the table, and the enums after the table:
--   DROP INDEX IF EXISTS "identity"."kyc_records_status_idx";
--   DROP INDEX IF EXISTS "identity"."kyc_records_user_recent_idx";
--   DROP INDEX IF EXISTS "identity"."kyc_records_external_id_key";
--   DROP TABLE "identity"."kyc_records";
--   DROP TYPE  "identity"."kyc_status";
--   DROP TYPE  "identity"."kyc_provider";
-- Safe in isolation — no other table references this one and no FK /
-- CHECK constraints rely on these enums. A rollback restarts the KYC
-- subsystem from a clean slate; provider promotion (TS-051) gates on
-- `verified`, so a clean slate temporarily blocks tier promotion but
-- does not corrupt any other auth state.
--
-- The schema design is documented in detail on the `KycRecord` model
-- in `schema.prisma`.

-- CreateEnum: kyc_provider -----------------------------------------------
CREATE TYPE "identity"."kyc_provider" AS ENUM ('stripe_identity');

-- CreateEnum: kyc_status -------------------------------------------------
CREATE TYPE "identity"."kyc_status" AS ENUM (
    'pending',
    'processing',
    'verified',
    'requires_input',
    'failed',
    'canceled'
);

-- CreateTable: kyc_records ----------------------------------------------
CREATE TABLE "identity"."kyc_records" (
    "id"                    TEXT                       NOT NULL,
    "user_id"               TEXT                       NOT NULL,
    "provider"              "identity"."kyc_provider"  NOT NULL,
    "status"                "identity"."kyc_status"    NOT NULL DEFAULT 'pending',
    "external_id"           TEXT                       NOT NULL,
    "payload_ciphertext"    BYTEA,
    "payload_iv"            BYTEA,
    "payload_auth_tag"      BYTEA,
    "payload_key_version"   INTEGER,
    "last_event_id"         TEXT,
    "verified_at"           TIMESTAMPTZ(6),
    "created_at"            TIMESTAMPTZ(6)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMPTZ(6)             NOT NULL,

    CONSTRAINT "kyc_records_pkey" PRIMARY KEY ("id")
);

-- Stripe `verificationSession.id` is the natural webhook lookup key.
-- The unique constraint guards against pathological races where two
-- concurrent `startSession` calls land twin rows for the same Stripe
-- session — Stripe's id space is wide enough that this should never
-- collide on the legitimate path, but the index makes "find by
-- externalId" a single-row primary-key lookup regardless.
CREATE UNIQUE INDEX "kyc_records_external_id_key"
    ON "identity"."kyc_records"("external_id");

-- Powers `getLatestForUser` — the dominant read path. The DESC
-- ordering on `created_at` lets Postgres return the most-recent row
-- for a userId in one indexed lookup without an extra sort step.
CREATE INDEX "kyc_records_user_recent_idx"
    ON "identity"."kyc_records"("user_id", "created_at" DESC);

-- Powers admin queries like "every record currently in
-- `requires_input`". Kept full (not partial) because Phase 1
-- cardinality is bounded; promote to partial if the table grows
-- past million-row scale (low priority — captured as a TS-026
-- follow-up if it ever matters).
CREATE INDEX "kyc_records_status_idx"
    ON "identity"."kyc_records"("status");
