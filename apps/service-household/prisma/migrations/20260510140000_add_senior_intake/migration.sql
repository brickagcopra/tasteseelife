-- TS-031 — senior intake form (PDD §16.3, §21.3; CLAUDE.md §3, §17.1).
--
-- Forward-only expand migration. Adds nothing to the existing tables
-- shipped by TS-030 except additive columns on `household.seniors`:
--
--   * Two new enums (`senior_mobility_level`, `senior_dementia_status`)
--     hold the operational, queryable classifications.
--   * Three TEXT[] columns (`language_tags`, `dietary_tags`,
--     `allergen_tags`) hold the operational tag lists that drive provider
--     search and chef-match.
--   * Two enum columns (`mobility_level`, `dementia_status`) classify
--     coarse-grained operational state.
--   * Four BYTEA / INTEGER columns (`intake_payload_ciphertext`,
--     `intake_payload_iv`, `intake_payload_auth_tag`,
--     `intake_payload_key_version`) hold the AES-256-GCM envelope-encrypted
--     payload — DOB plus the four freeform notes fields — see
--     `IntakePayloadCipherService` for the algorithm rationale.
--   * `intake_completed_at` timestamp marks when the family first
--     completed the intake (drives the dashboard nudge).
--
-- Every new column is nullable / has a non-null default, so the migration
-- is non-blocking against the existing rows (zero today, but the contract
-- with TS-030 is "additive expand-only"). The plain operational columns
-- default to empty arrays / `unknown` / `none` so chef-match queries can
-- run against the column unconditionally without a special-case NULL
-- branch.
--
-- A partial index on `intake_completed_at IS NULL` would let the family
-- dashboard's "show me households with incomplete intakes" query scan a
-- bounded population, but the query doesn't exist yet (TS-121 is the
-- earliest consumer). Captured as a TS-031-followup if the read pattern
-- materialises. The two operational enum columns get straight-up
-- indexes so the chef-match query can filter at search time once the
-- denormalised provider index is built (TS-053 / TS-111).
--
-- Reversal plan (forward-compatible — execute in reverse order):
--   ALTER TABLE "household"."seniors"
--     DROP COLUMN "intake_completed_at",
--     DROP COLUMN "intake_payload_key_version",
--     DROP COLUMN "intake_payload_auth_tag",
--     DROP COLUMN "intake_payload_iv",
--     DROP COLUMN "intake_payload_ciphertext",
--     DROP COLUMN "dementia_status",
--     DROP COLUMN "mobility_level",
--     DROP COLUMN "allergen_tags",
--     DROP COLUMN "dietary_tags",
--     DROP COLUMN "language_tags";
--   DROP INDEX "household"."seniors_dementia_status_idx";
--   DROP INDEX "household"."seniors_mobility_level_idx";
--   DROP TYPE "household"."senior_dementia_status";
--   DROP TYPE "household"."senior_mobility_level";
-- Safe in isolation because no other service references these columns.
--
-- Apply locally with:
--   pnpm -F @taste-and-see/service-household prisma:migrate:deploy

-- CreateEnum
CREATE TYPE "household"."senior_mobility_level" AS ENUM (
  'unknown',
  'independent',
  'aided_cane',
  'aided_walker',
  'wheelchair',
  'bedridden'
);

-- CreateEnum
CREATE TYPE "household"."senior_dementia_status" AS ENUM (
  'none',
  'mild_cognitive_impairment',
  'early_dementia',
  'moderate_dementia',
  'advanced_dementia'
);

-- AlterTable — operational intake columns (plain, queryable).
ALTER TABLE "household"."seniors"
  ADD COLUMN "language_tags"  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "dietary_tags"   TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "allergen_tags"  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "mobility_level"  "household"."senior_mobility_level"  NOT NULL DEFAULT 'unknown',
  ADD COLUMN "dementia_status" "household"."senior_dementia_status" NOT NULL DEFAULT 'none';

-- AlterTable — sensitive intake columns (encrypted, nullable).
-- Both ciphertext + IV + auth_tag + key_version are nullable as a
-- group: the IntakeService.upsert path writes all four atomically;
-- a partially-non-null row is a service-layer bug.
ALTER TABLE "household"."seniors"
  ADD COLUMN "intake_payload_ciphertext"   BYTEA,
  ADD COLUMN "intake_payload_iv"           BYTEA,
  ADD COLUMN "intake_payload_auth_tag"     BYTEA,
  ADD COLUMN "intake_payload_key_version"  INTEGER,
  ADD COLUMN "intake_completed_at"         TIMESTAMPTZ(6);

-- Operational chef-match filter indexes. Both are low-cardinality
-- enums; the chef-match query joins these against the provider
-- specialty index (TS-053 builds the denormalised provider doc), so
-- a straight B-tree on each column is the right shape — at scale we
-- might revisit with a covering index that also pulls `household_id`
-- but that's a Phase 2 optimisation.
CREATE INDEX "seniors_mobility_level_idx"
  ON "household"."seniors"("mobility_level");
CREATE INDEX "seniors_dementia_status_idx"
  ON "household"."seniors"("dementia_status");
