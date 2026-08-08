-- TS-283 — author profiles + multi-author collaboration (PDD §19.1; PRD §10.10).
--
-- Forward-only expand migration. Adds:
--   1. the `content_author_role` enum (`primary` | `co_author`),
--   2. `content.content_authors`  — a content-staff author profile (bio, photo,
--      social links) keyed by a UNIQUE soft `user_id` (service-identity ref),
--   3. `content.article_authors`  — the ordered many-to-many byline credit
--      linking an article to its authors.
--
-- Both FKs on `article_authors` are IN-SCHEMA (declared): `article_id` cascades
-- (a byline credit dies with the article); `author_id` RESTRICTs (an author still
-- credited on an article cannot be deleted — the credit must be unlinked first,
-- protecting the historical byline). No backfill (greenfield; pre-existing
-- articles simply carry no author links until set). No mutations to existing
-- rows; all additive → zero-downtime (expand → migrate → contract, CLAUDE.md §4.1).
--
-- Reversal plan (safe in isolation — the new tables have no inbound FK):
--   DROP TABLE IF EXISTS "content"."article_authors";
--   DROP TABLE IF EXISTS "content"."content_authors";
--   DROP TYPE  IF EXISTS "content"."content_author_role";
--
-- Apply with:
--   pnpm -F @taste-and-see/service-content prisma:migrate:deploy

-- CreateEnum: the credited-author role.
CREATE TYPE "content"."content_author_role" AS ENUM (
  'primary',
  'co_author'
);

-- CreateTable: content-staff author profiles. `user_id` is a UNIQUE soft FK into
-- service-identity (one profile per identity); `photo_asset_key` is a media
-- assetKey reference; `social_links` is a JSON object of http(s) URLs.
CREATE TABLE "content"."content_authors" (
  "id"              TEXT           NOT NULL,
  "user_id"         TEXT           NOT NULL,
  "display_name"    TEXT           NOT NULL,
  "bio"             TEXT,
  "photo_asset_key" TEXT,
  "social_links"    JSONB,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "content_authors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: one author profile per service-identity user.
CREATE UNIQUE INDEX "content_authors_user_id_key" ON "content"."content_authors"("user_id");

-- CreateTable: the ordered many-to-many byline credit. `article_id` → articles
-- (CASCADE); `author_id` → content_authors (RESTRICT).
CREATE TABLE "content"."article_authors" (
  "id"          TEXT                         NOT NULL,
  "article_id"  TEXT                         NOT NULL,
  "author_id"   TEXT                         NOT NULL,
  "author_role" "content"."content_author_role" NOT NULL DEFAULT 'co_author',
  "sort_order"  INTEGER                      NOT NULL DEFAULT 0,
  "created_at"  TIMESTAMPTZ(6)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6)               NOT NULL,

  CONSTRAINT "article_authors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "article_authors_article_id_fkey"
    FOREIGN KEY ("article_id")
    REFERENCES "content"."articles"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "article_authors_author_id_fkey"
    FOREIGN KEY ("author_id")
    REFERENCES "content"."content_authors"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex: "authors of this article" — the byline read (ordered by sort_order).
CREATE INDEX "article_authors_article_id_idx" ON "content"."article_authors"("article_id");
-- CreateIndex: "articles this author is credited on" — the RESTRICT existence check.
CREATE INDEX "article_authors_author_id_idx" ON "content"."article_authors"("author_id");
-- CreateIndex: an author is credited at most once per article.
CREATE UNIQUE INDEX "article_authors_article_id_author_id_key"
  ON "content"."article_authors"("article_id", "author_id");
