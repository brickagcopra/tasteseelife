-- TS-052 — Provider certifications + tier promotion + tier history.
--
-- Adds three new tables and one new enum inside the existing
-- `provider` schema. No changes to the `providers` table (the tier
-- column already exists from TS-050; this migration adds the
-- *machinery* that flips it). No changes to the application or
-- background-check tables.
--
-- Forward-compatible expand-only migration (CLAUDE.md §4.1).
-- Existing `providers` rows stay queryable — they simply have no
-- matching certifications and no tier-history rows until ops grants
-- credentials or evaluates tier.
--
-- Reversal plan: drop in reverse-creation order so the indexes
-- unwind before the tables and the enum after the tables.
--
--   DROP INDEX IF EXISTS "provider"."provider_tier_history_provider_occurred_idx";
--   DROP TABLE  "provider"."provider_tier_history";
--   DROP INDEX IF EXISTS "provider"."provider_certifications_active_unique_idx";
--   DROP INDEX IF EXISTS "provider"."provider_certifications_expires_at_idx";
--   DROP INDEX IF EXISTS "provider"."provider_certifications_certification_idx";
--   DROP INDEX IF EXISTS "provider"."provider_certifications_provider_idx";
--   DROP TABLE  "provider"."provider_certifications";
--   DROP INDEX IF EXISTS "provider"."certifications_code_key";
--   DROP TABLE  "provider"."certifications";
--   DROP TYPE   "provider"."tier_transition_reason";
--
-- Safe in isolation — no other table references these rows. A
-- rollback temporarily prevents the certifications + tier-promotion
-- machinery from operating but leaves every existing provider row
-- and every prior tier value intact.
--
-- The schema design is documented in detail on the `Certification`,
-- `ProviderCertification`, and `ProviderTierHistory` models in
-- `schema.prisma`.

-- CreateEnum: tier_transition_reason -----------------------------------
CREATE TYPE "provider"."tier_transition_reason" AS ENUM (
    'auto_evaluation',
    'admin_override'
);

-- CreateTable: certifications (catalog) --------------------------------
CREATE TABLE "provider"."certifications" (
    "id"                       TEXT            NOT NULL,
    "code"                     TEXT            NOT NULL,
    "name"                     TEXT            NOT NULL,
    "description"              TEXT            NOT NULL,
    "issuer"                   TEXT            NOT NULL,
    "default_validity_months"  INTEGER,
    "sort_position"            INTEGER         NOT NULL DEFAULT 0,
    "active"                   BOOLEAN         NOT NULL DEFAULT TRUE,
    "created_at"               TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMPTZ(6)  NOT NULL,

    CONSTRAINT "certifications_pkey" PRIMARY KEY ("id")
);

-- `code` is the stable identifier referenced by the seed catalog
-- and by the tier-promotion rules. Unique by definition.
CREATE UNIQUE INDEX "certifications_code_key"
    ON "provider"."certifications"("code");

-- CreateTable: provider_certifications (issuance log) -------------------
CREATE TABLE "provider"."provider_certifications" (
    "id"                  TEXT            NOT NULL,
    "provider_id"         TEXT            NOT NULL,
    "certification_id"    TEXT            NOT NULL,
    "issued_at"           TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"          TIMESTAMPTZ(6),
    "revoked_at"          TIMESTAMPTZ(6),
    "revocation_reason"   TEXT,
    "issuer_user_id"      TEXT,
    "revoker_user_id"     TEXT,
    "notes"               TEXT,
    "created_at"          TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ(6)  NOT NULL,

    CONSTRAINT "provider_certifications_pkey" PRIMARY KEY ("id")
);

-- Powers `listForProvider(providerId)` — the dominant read path for
-- the provider-portal self-view + the ops review surface.
CREATE INDEX "provider_certifications_provider_idx"
    ON "provider"."provider_certifications"("provider_id");

-- Powers "every provider who holds <certification>" — used by
-- search-indexer projections (TS-053) and by ops reporting.
CREATE INDEX "provider_certifications_certification_idx"
    ON "provider"."provider_certifications"("certification_id");

-- Powers the future expiry-worker (TS-052-followup) that demotes
-- providers whose gate certifications lapse. Partial index keeps
-- footprint bounded — the worker only scans rows with an explicit
-- expiry date.
CREATE INDEX "provider_certifications_expires_at_idx"
    ON "provider"."provider_certifications"("expires_at")
    WHERE "expires_at" IS NOT NULL AND "revoked_at" IS NULL;

-- Belt-and-braces against a duplicate active grant. A (provider,
-- certification) pair has at most one active row (revoked_at IS
-- NULL). Re-granting after revoke creates a fresh row — the partial
-- predicate scopes uniqueness to the active set.
CREATE UNIQUE INDEX "provider_certifications_active_unique_idx"
    ON "provider"."provider_certifications"("provider_id", "certification_id")
    WHERE "revoked_at" IS NULL;

-- CreateTable: provider_tier_history (append-only audit) ----------------
CREATE TABLE "provider"."provider_tier_history" (
    "id"                       TEXT                                 NOT NULL,
    "provider_id"              TEXT                                 NOT NULL,
    "from_tier"                "provider"."provider_tier",
    "to_tier"                  "provider"."provider_tier"           NOT NULL,
    "reason"                   "provider"."tier_transition_reason"  NOT NULL,
    "triggered_by_user_id"     TEXT,
    "notes"                    TEXT,
    "occurred_at"              TIMESTAMPTZ(6)                       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"               TIMESTAMPTZ(6)                       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_tier_history_pkey" PRIMARY KEY ("id")
);

-- Powers `getHistory(providerId)` — the ops review page renders the
-- full transition log newest-first.
CREATE INDEX "provider_tier_history_provider_occurred_idx"
    ON "provider"."provider_tier_history"("provider_id", "occurred_at" DESC);
