-- TS-282 — per-article SEO metadata (PDD §19.1; PRD §10.10).
--
-- Forward-only expand migration. Adds NULLABLE SEO columns to `content.articles`
-- (SEO title, meta description, canonical URL, OpenGraph card, Twitter card,
-- JSON-LD structured data). SEO lives on the ARTICLE — a stable canonical /
-- social identity — NOT per `article_versions` row, so a canonical URL or social
-- card does not fork every time the body is revised.
--
-- No backfill (a greenfield deploy has no rows; pre-existing articles keep all
-- SEO columns NULL = "not set", the surface falls back to the article title /
-- rendered content). No mutations to existing rows; no destructive DDL; all
-- columns additive → zero-downtime (expand → migrate → contract, CLAUDE.md §4.1).
--
-- Image fields (`og_image_key`, `twitter_image_key`) are media assetKey
-- references (nullable text), same posture as ad creatives — the web-admin media
-- upload flow is a separate, deferred concern. `json_ld` is `jsonb` — a
-- schema.org JSON object, re-emitted in a `<script type="application/ld+json">`
-- by the public read surface (TS-282-followup-1).
--
-- No index: SEO columns are read as part of the single-article detail row and are
-- never a `where` predicate at scale (CLAUDE.md §4.1 / §7.3).
--
-- Reversal plan (safe in isolation — all columns nullable, no FK / no view):
--   ALTER TABLE "content"."articles"
--     DROP COLUMN IF EXISTS "seo_title",
--     DROP COLUMN IF EXISTS "meta_description",
--     DROP COLUMN IF EXISTS "canonical_url",
--     DROP COLUMN IF EXISTS "og_title",
--     DROP COLUMN IF EXISTS "og_description",
--     DROP COLUMN IF EXISTS "og_image_key",
--     DROP COLUMN IF EXISTS "twitter_card",
--     DROP COLUMN IF EXISTS "twitter_title",
--     DROP COLUMN IF EXISTS "twitter_description",
--     DROP COLUMN IF EXISTS "twitter_image_key",
--     DROP COLUMN IF EXISTS "json_ld";
--
-- Apply with:
--   pnpm -F @taste-and-see/service-content prisma:migrate:deploy

-- AlterTable: add the nullable per-article SEO columns.
ALTER TABLE "content"."articles"
    ADD COLUMN "seo_title" TEXT,
    ADD COLUMN "meta_description" TEXT,
    ADD COLUMN "canonical_url" TEXT,
    ADD COLUMN "og_title" TEXT,
    ADD COLUMN "og_description" TEXT,
    ADD COLUMN "og_image_key" TEXT,
    ADD COLUMN "twitter_card" TEXT,
    ADD COLUMN "twitter_title" TEXT,
    ADD COLUMN "twitter_description" TEXT,
    ADD COLUMN "twitter_image_key" TEXT,
    ADD COLUMN "json_ld" JSONB;
