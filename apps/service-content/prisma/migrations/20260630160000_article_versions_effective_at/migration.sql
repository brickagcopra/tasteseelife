-- TS-284-followup-3 — blog/help articles versioning: the `effective_at`
-- compliance column on `content.article_versions` (PDD §19; PRD §10.10/§10.11).
--
-- Forward-only expand migration mirroring `20260630140000_page_versions_effective_at`.
-- Adds a NULLABLE `effective_at` column (no backfill — pre-existing versions,
-- of which there are none in a greenfield deploy, stay NULL = never-published)
-- plus its lookup index. No mutations to existing rows; no destructive DDL; the
-- column is additive so the deploy is zero-downtime (expand → migrate →
-- contract, CLAUDE.md §4.1).
--
-- `effective_at` is stamped by the `publish` action (service-content
-- `ArticlesService.publishVersion`): omitted = the publish instant, supplied =
-- a future / backdated effective date. A published-then-superseded version
-- keeps its historical `effective_at`.
--
-- Reversal plan:
--   DROP INDEX IF EXISTS "content"."article_versions_effective_at_idx";
--   ALTER TABLE "content"."article_versions" DROP COLUMN IF EXISTS "effective_at";
-- Safe in isolation — the column is nullable with no FK / no dependent view.
--
-- Apply with:
--   pnpm -F @taste-and-see/service-content prisma:migrate:deploy

-- AlterTable: add the nullable compliance-effective timestamp.
ALTER TABLE "content"."article_versions"
    ADD COLUMN "effective_at" TIMESTAMPTZ(6);

-- CreateIndex: "which article versions take effect in this window" (the
-- cross-article effective-date scan). The dominant per-article history read is
-- bounded by the existing `article_versions_article_id_idx`; this standalone
-- index serves the unbounded-by-article effective-date scan (CLAUDE.md §7.3).
CREATE INDEX "article_versions_effective_at_idx"
    ON "content"."article_versions" ("effective_at");
