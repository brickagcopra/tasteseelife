-- TS-200 — Provider self-service profile editor.
--
-- Adds one polymorphic table (`provider_profile_tags`), one new enum
-- (`provider_profile_tag_kind`), and one new column on `providers`
-- (`dementia_sensitive` boolean). Together they back the
-- `PUT /api/v1/providers/:providerId/profile` surface the
-- web-provider editor calls (TS-200) and the discovery doc consumes
-- (TS-111 already projects the tag arrays from in-event payloads;
-- once this migration lands the indexer reads from the source-of-
-- truth columns/rows added here).
--
-- Forward-compatible expand-only migration (CLAUDE.md §4.1):
--
--   - The `dementia_sensitive` column is added with a `DEFAULT FALSE`
--     and `NOT NULL` constraint. Existing `providers` rows back-fill
--     atomically at ADD COLUMN time (Postgres optimises the
--     constant-default add to a metadata-only operation on Postgres
--     12+ — no full-table rewrite).
--
--   - The `provider_profile_tags` table is brand new. No existing
--     reads/writes touch it. The TS-200 service-provider profile
--     module is the first writer; the search-indexer (TS-053) will
--     pivot to reading it once TS-200 lands.
--
--   - The `provider_profile_tag_kind` enum is created fresh. No
--     existing types reference it.
--
-- No data migration step needed — the new column populates with the
-- safe-default value (FALSE), and the tag table starts empty. The
-- web-provider editor (TS-200) writes the first rows as providers
-- update their profiles.
--
-- Reversal plan (drop in reverse-creation order):
--
--   ALTER TABLE "provider"."providers" DROP COLUMN "dementia_sensitive";
--   DROP INDEX IF EXISTS "provider"."provider_profile_tags_provider_kind_idx";
--   DROP INDEX IF EXISTS "provider"."provider_profile_tags_kind_tag_idx";
--   DROP INDEX IF EXISTS "provider"."provider_profile_tags_unique_idx";
--   DROP TABLE "provider"."provider_profile_tags";
--   DROP TYPE  "provider"."provider_profile_tag_kind";
--
-- Safe in isolation — the new column has a default so no read
-- breaks; the new table has no inbound FKs so it drops cleanly. A
-- rollback temporarily prevents the TS-200 profile-edit surface
-- from functioning but leaves every existing provider row intact.

-- CreateEnum: provider_profile_tag_kind -----------------------------------
--
-- Three variants matching the contract-layer
-- `ProviderProfileTagKindSchema` (packages/contracts/src/http/
-- provider-profile.schema.ts): `language`, `cuisine`,
-- `dietary_expertise`. The enum is the source of truth at the DB
-- layer; the contract enum mirrors the catalog rather than the
-- other way around because the polymorphic table cannot be
-- constraint-checked without a real Postgres enum on the column.
CREATE TYPE "provider"."provider_profile_tag_kind" AS ENUM (
    'language',
    'cuisine',
    'dietary_expertise'
);

-- CreateTable: provider_profile_tags --------------------------------------
--
-- One row per (provider, kind, tag) triple. The polymorphic shape
-- collapses what would otherwise be three sibling tables
-- (`provider_languages`, `provider_cuisines`,
-- `provider_dietary_expertise`) per PDD §8.2's original wording.
-- The trade-off — slightly less typed structure at the table level
-- — is paid back by:
--
--   1. One migration to drop / one to evolve, not three.
--   2. One repository / one outbox composition.
--   3. The discovery doc (TS-111) already shapes these as flat tag
--      arrays per kind — the polymorphic table aligns 1:1 with the
--      doc's projection shape.
--
-- The `kind` column is constrained by the enum so an INSERT with
-- an unknown kind value fails at the DB layer (defence-in-depth
-- against a Zod miss at the controller boundary).
--
-- `tag` is normalised lowercase + hyphen + underscore at the
-- contract layer (regex `^[a-z0-9][a-z0-9_-]*$`, max 48 chars).
-- The column is unconstrained TEXT — we trust the contract layer +
-- the unique index below to catch malformed values. The longest
-- realistic tag (`zh-Hant-HK`) sits at 10 chars, so even a
-- worst-case 32-tag-per-kind × 3-kind row produces ~96 short rows
-- per provider; total table size scales linearly with active
-- provider count + their tag richness.
CREATE TABLE "provider"."provider_profile_tags" (
    "id"           TEXT                                 NOT NULL,
    "provider_id"  TEXT                                 NOT NULL,
    "kind"         "provider"."provider_profile_tag_kind" NOT NULL,
    "tag"          TEXT                                 NOT NULL,
    "created_at"   TIMESTAMPTZ(6)                       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_profile_tags_pkey" PRIMARY KEY ("id")
);

-- Powers the dominant read path — `listForProvider(providerId)`
-- + the editor's initial render which fetches every (provider,
-- kind, tag) row for one provider, partitioned client-side by
-- kind. The `(provider_id, kind)` shape lets the indexer query
-- "every cuisine for provider X" without a separate index.
CREATE INDEX "provider_profile_tags_provider_kind_idx"
    ON "provider"."provider_profile_tags"("provider_id", "kind");

-- Powers the future "every provider claiming <tag>" read — used by
-- the family-portal search-indexer (TS-053) to invalidate stale
-- discovery docs when a tag's underlying catalogue meaning shifts.
-- Today the indexer reads forward (provider_id → tags), but a
-- tag-deprecation pathway (TS-200-followup-6) would need the
-- reverse direction.
CREATE INDEX "provider_profile_tags_kind_tag_idx"
    ON "provider"."provider_profile_tags"("kind", "tag");

-- Belt-and-braces against a duplicate row inside a single
-- (provider, kind) bucket. The contract layer rejects duplicate
-- tags inside an array at the boundary (see
-- `ProviderProfileTagArraySchema.superRefine`), but a malformed
-- direct write (admin tooling, repair script) would surface as a
-- 23505 PG unique-violation here rather than silently bloating the
-- tag set.
CREATE UNIQUE INDEX "provider_profile_tags_unique_idx"
    ON "provider"."provider_profile_tags"("provider_id", "kind", "tag");

-- AlterTable: providers.dementia_sensitive --------------------------------
--
-- Boolean column populated by the TS-200 profile editor. The
-- family-portal search filter on dementia-sensitive providers
-- (PRD §6.1 / §6.3) reads this column via the discovery doc
-- projection (TS-111 already exposes the filter; the source-of-
-- truth column lands here so the editor has a place to write it).
--
-- `DEFAULT FALSE` so existing rows backfill atomically with a safe
-- "no claim either way" baseline. Active providers who hold a
-- dementia-sensitive specialty re-confirm it through the editor
-- post-deploy; until they do, the family-portal filter treats them
-- as "not specialised" — the safe default given the audience.
ALTER TABLE "provider"."providers"
    ADD COLUMN "dementia_sensitive" BOOLEAN NOT NULL DEFAULT FALSE;
