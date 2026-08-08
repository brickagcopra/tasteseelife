-- TS-284 — static-pages versioning: the `effective_at` compliance column on
-- `content.page_versions` (PDD §19.2; PRD §10.11).
--
-- Forward-only expand migration. Adds a NULLABLE `effective_at` column (no
-- backfill — pre-existing versions, of which there are none in a greenfield
-- deploy, stay NULL = never-published) plus its lookup index. No mutations to
-- existing rows; no destructive DDL; the column is additive so the deploy is
-- zero-downtime (expand → migrate → contract, CLAUDE.md §4.1).
--
-- `effective_at` is stamped by the `publish` action (service-content
-- `PagesService.publishVersion`): omitted = the publish instant, supplied = a
-- future / backdated compliance-effective date. A published-then-superseded
-- version keeps its historical `effective_at` so "which terms were in force on
-- date X" is reconstructable.
--
-- Reversal plan:
--   DROP INDEX IF EXISTS "content"."page_versions_effective_at_idx";
--   ALTER TABLE "content"."page_versions" DROP COLUMN IF EXISTS "effective_at";
-- Safe in isolation — the column is nullable with no FK / no dependent view.
--
-- Apply with:
--   pnpm -F @taste-and-see/service-content prisma:migrate:deploy

-- AlterTable: add the nullable compliance-effective timestamp.
ALTER TABLE "content"."page_versions"
    ADD COLUMN "effective_at" TIMESTAMPTZ(6);

-- CreateIndex: "which versions take effect in this window" (the cross-page
-- compliance scan). The dominant per-page "effective as of X" read is bounded
-- by the existing `page_versions_page_id_idx`; this standalone index serves the
-- unbounded-by-page effective-date scan (CLAUDE.md §7.3).
CREATE INDEX "page_versions_effective_at_idx"
    ON "content"."page_versions" ("effective_at");
