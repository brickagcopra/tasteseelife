-- TS-223 — concierge custom-request / service-request submission.
--
-- Adds request-detail columns to the existing `concierge.concierge_tickets`
-- table (created by the TS-221 skeleton): the free-text subject + body and
-- the optional structured fields (requested date / party size / theme) the
-- family portal submits (PRD §6.6 "Concierge Service Requests"; PDD §10.6).
-- Also adds a composite index for the family "my requests" read.
--
-- Forward-compatible expand-only migration (CLAUDE.md §4.1). The `subject`
-- and `body` columns are NOT NULL with no default: `concierge_tickets` has
-- had NO write surface in any environment prior to this migration (TS-221
-- created the table; TS-222 wrote only to `concierge_assignments`), so the
-- table is provably empty everywhere and the NOT NULL adds cannot fail on
-- existing rows. The first writer is the TS-223 submit endpoint, which
-- always supplies both. (Were the table populated, the canonical pattern
-- would be add-nullable → backfill → set-not-null; that is unnecessary
-- here.)
--
-- The remaining columns (`requested_date`, `party_size`, `theme`) are
-- nullable — they are optional structured fields on the request.
--
-- Cross-service references are by id only (CLAUDE.md §2.3): the table's
-- existing `household_id` / `assigned_to_user_id` columns are soft FKs into
-- `household.households` / `identity.users`; this migration adds no new
-- cross-service references.
--
-- Reversal plan (drop the index first, then the columns):
--   DROP INDEX IF EXISTS "concierge"."concierge_tickets_household_created_idx";
--   ALTER TABLE "concierge"."concierge_tickets"
--     DROP COLUMN IF EXISTS "theme",
--     DROP COLUMN IF EXISTS "party_size",
--     DROP COLUMN IF EXISTS "requested_date",
--     DROP COLUMN IF EXISTS "body",
--     DROP COLUMN IF EXISTS "subject";
-- Safe in isolation — no other service schema references these objects.
--
-- Migration authored by hand to match prisma/schema.prisma. Apply with:
--   pnpm -F @taste-and-see/service-concierge prisma:migrate:deploy

-- AlterTable
ALTER TABLE "concierge"."concierge_tickets"
  ADD COLUMN "subject"        TEXT    NOT NULL,
  ADD COLUMN "body"           TEXT    NOT NULL,
  ADD COLUMN "requested_date" DATE,
  ADD COLUMN "party_size"     INTEGER,
  ADD COLUMN "theme"          TEXT;

-- CreateIndex
-- Powers the family "my requests" read (TS-223): "this household's tickets
-- newest-first". Composite so a single index scan filters by household AND
-- returns rows in created_at-descending order without a separate sort.
CREATE INDEX "concierge_tickets_household_created_idx"
  ON "concierge"."concierge_tickets"("household_id", "created_at" DESC);
