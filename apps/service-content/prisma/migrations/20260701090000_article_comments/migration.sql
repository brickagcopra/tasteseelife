-- TS-289 — per-article comments configuration (PDD §19.1; PRD §10.10).
--
-- Forward-only expand migration. Adds the per-post comments-config columns to
-- `content.articles`. Comments config lives on the ARTICLE (like the TS-282 SEO
-- block — stable per-post configuration, not per `article_versions` row).
--
--   comments_enabled  BOOLEAN NOT NULL DEFAULT false — the per-post toggle.
--                     Defaults OFF: comments stay dark until the public blog
--                     read surface ships (TS-289-followup-1).
--   comments_provider TEXT NOT NULL DEFAULT 'disqus' — the wire enum `disqus`
--                     (the PDD-default embed) / `none`, persisted as text so a
--                     future provider (e.g. self_hosted) arrives without DDL.
--   disqus_identifier TEXT NULL — the stable per-thread Disqus identifier;
--                     NULL = the public embed falls back to the article slug/id.
--
-- No backfill (a greenfield deploy has no rows; pre-existing articles pick up
-- the column defaults = comments off, Disqus provider). No mutations to existing
-- rows beyond the default fill; no destructive DDL; all columns additive →
-- zero-downtime (expand → migrate → contract, CLAUDE.md §4.1).
--
-- No index: comments columns are read as part of the single-article detail row
-- and are never a `where` predicate at scale (CLAUDE.md §4.1 / §7.3).
--
-- Reversal plan (safe in isolation — no FK / no view depends on these):
--   ALTER TABLE "content"."articles"
--     DROP COLUMN IF EXISTS "comments_enabled",
--     DROP COLUMN IF EXISTS "comments_provider",
--     DROP COLUMN IF EXISTS "disqus_identifier";
--
-- Apply with:
--   pnpm -F @taste-and-see/service-content prisma:migrate:deploy

-- AlterTable: add the per-article comments-config columns.
ALTER TABLE "content"."articles"
    ADD COLUMN "comments_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "comments_provider" TEXT NOT NULL DEFAULT 'disqus',
    ADD COLUMN "disqus_identifier" TEXT;
