-- TS-042 — dunning + grace + pause/resume.
--
-- Forward-only expand migration. Adds six columns to the existing
-- `subscription.subscriptions` table and one composite index for the
-- dunning sweeper. Every added column is NULLable OR has a server-side
-- default (NOT NULL DEFAULT 0 on `dunning_attempts`), so backfilling
-- existing rows is a no-op (CLAUDE.md §4.1, §4.4).
--
-- Reversal plan:
--   DROP INDEX  "subscription"."subscriptions_dunning_grace_idx";
--   ALTER TABLE "subscription"."subscriptions"
--     DROP COLUMN "dunning_attempts",
--     DROP COLUMN "dunning_last_attempt_at",
--     DROP COLUMN "dunning_grace_until",
--     DROP COLUMN "pause_collection_started_at",
--     DROP COLUMN "pause_collection_resumes_at",
--     DROP COLUMN "pause_reason";
-- Safe in isolation — no FK / CHECK constraint references these columns
-- from other tables, and no other service schema references them
-- (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Apply locally with:
--   pnpm -F @taste-and-see/service-subscription prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- AlterTable: TS-042 columns. Note the `DEFAULT 0` on dunning_attempts —
-- existing rows are backfilled to 0 (= "never been in dunning this cycle").
-- The five DateTime columns are NULLable so existing rows backfill to NULL.
ALTER TABLE "subscription"."subscriptions"
  ADD COLUMN "dunning_attempts"              INTEGER         NOT NULL DEFAULT 0,
  ADD COLUMN "dunning_last_attempt_at"       TIMESTAMPTZ(6),
  ADD COLUMN "dunning_grace_until"           TIMESTAMPTZ(6),
  ADD COLUMN "pause_collection_started_at"   TIMESTAMPTZ(6),
  ADD COLUMN "pause_collection_resumes_at"   TIMESTAMPTZ(6),
  ADD COLUMN "pause_reason"                  TEXT;

-- CreateIndex — dunning sweeper read path:
--   "show me rows whose grace expired so we can apply exhaustion".
-- Plain composite — a partial index `WHERE status='past_due' AND
-- dunning_grace_until IS NOT NULL` would be more selective and lands
-- as TS-042-followup-1.
CREATE INDEX "subscriptions_dunning_grace_idx"
  ON "subscription"."subscriptions"("dunning_grace_until");
