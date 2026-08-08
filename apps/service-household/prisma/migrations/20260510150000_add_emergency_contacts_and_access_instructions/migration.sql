-- TS-032 — emergency contacts + household access instructions
-- (PRD §6.1, PDD §8.2, §16.3, §21.3; CLAUDE.md §3, §17.1).
--
-- Forward-only expand migration. Two additive shape changes:
--
--   1. NEW TABLE `household.emergency_contacts` — household-scoped
--      roster of who-to-call. Plain columns (name / relationship /
--      phone / email / priority / notes) because the operational
--      concierge and visit-prep flows read them directly. Single
--      composite index drives the "list active contacts for this
--      household in priority order" query.
--
--   2. FIVE NEW COLUMNS on `household.households` for the AES-256-GCM
--      envelope-encrypted access-instructions payload:
--        * `access_instructions_ciphertext`     BYTEA  (nullable)
--        * `access_instructions_iv`             BYTEA  (nullable)
--        * `access_instructions_auth_tag`       BYTEA  (nullable)
--        * `access_instructions_key_version`    INTEGER (nullable)
--        * `access_instructions_updated_at`     TIMESTAMPTZ (nullable)
--      The four ciphertext columns are written and cleared atomically
--      by `AccessInstructionsService`; a partially-non-null group is a
--      service-layer bug. Algorithm and key-versioning rationale lives
--      on `AccessInstructionsCipherService` — mirrors the senior-intake
--      cipher but binds an independent key
--      (`HOUSEHOLD_ACCESS_ENC_KEY` / `_VERSION`) so the blast radius of
--      either key leak is bounded per data class.
--
-- All additions are nullable / have safe defaults, so the migration is
-- non-blocking against existing rows. No data backfill required.
--
-- Reversal plan (forward-compatible — execute in reverse order):
--   DROP INDEX  "household"."emergency_contacts_household_active_idx";
--   DROP TABLE  "household"."emergency_contacts";
--   ALTER TABLE "household"."households"
--     DROP COLUMN "access_instructions_updated_at",
--     DROP COLUMN "access_instructions_key_version",
--     DROP COLUMN "access_instructions_auth_tag",
--     DROP COLUMN "access_instructions_iv",
--     DROP COLUMN "access_instructions_ciphertext";
-- Safe in isolation because no other service references these columns
-- (cross-service relations are by id only — CLAUDE.md §2.3).
--
-- Apply locally with:
--   pnpm -F @taste-and-see/service-household prisma:migrate:deploy

-- AlterTable — household-access instructions (encrypted, nullable group)
ALTER TABLE "household"."households"
  ADD COLUMN "access_instructions_ciphertext"   BYTEA,
  ADD COLUMN "access_instructions_iv"           BYTEA,
  ADD COLUMN "access_instructions_auth_tag"     BYTEA,
  ADD COLUMN "access_instructions_key_version"  INTEGER,
  ADD COLUMN "access_instructions_updated_at"   TIMESTAMPTZ(6);

-- CreateTable — household-scoped emergency contacts roster
CREATE TABLE "household"."emergency_contacts" (
  "id"            TEXT          NOT NULL,
  "household_id"  TEXT          NOT NULL,
  "name"          TEXT          NOT NULL,
  "relationship"  TEXT          NOT NULL,
  "phone"         TEXT          NOT NULL,
  "email"         TEXT,
  "priority"      INTEGER       NOT NULL,
  "notes"         TEXT,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL,
  "deleted_at"    TIMESTAMPTZ(6),

  CONSTRAINT "emergency_contacts_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "household"."emergency_contacts"
  ADD CONSTRAINT "emergency_contacts_household_id_fkey"
  FOREIGN KEY ("household_id") REFERENCES "household"."households"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
-- Composite shape so a single index scan filters soft-deleted rows AND
-- returns priority-ordered results for the list endpoint. The leading
-- columns are the equality predicate (household_id + deleted_at IS
-- NULL), followed by the order-by keys (priority ASC, created_at ASC).
-- EXPLAIN ANALYZE on a populated dev DB shows this collapses to a
-- single index-only scan; raw seqscan would be acceptable too at the
-- 10-contacts-per-household cap but the index keeps the cost ceiling
-- flat as the table itself grows across the platform.
CREATE INDEX "emergency_contacts_household_active_idx"
  ON "household"."emergency_contacts"("household_id", "deleted_at", "priority", "created_at");
