-- TS-280 — initial content schema.
--
-- Creates the `content` Postgres schema and the five core tables (PDD §8.2,
-- §19):
--   1. `pages`             — live marketing / CMS pages.
--   2. `page_versions`     — append-only saved revisions of a page's body.
--   3. `help_categories`   — self-nesting help-center / blog taxonomy.
--   4. `articles`          — live blog / help articles.
--   5. `article_versions`  — append-only saved revisions of an article's body.
-- plus the `content_status` enum and indexes. Forward-compatible: subsequent
-- migrations add (never repurpose) per CLAUDE.md §4.1, and enum value sets grow
-- via `ALTER TYPE … ADD VALUE` per the TS-205 / TS-220 convention.
--
-- Versioning model: `pages` / `articles` carry a nullable `current_version_id`
-- SOFT pointer (NOT a declared FK) to the `*_versions` row they currently
-- render — this avoids the circular entity ⇄ version insert-order constraint;
-- the head is moved by the authoring service (TS-281/282), not by referential
-- integrity. The `*_versions` tables are append-only (a new row per save).
--
-- Cross-service references are by id only (CLAUDE.md §2.3): `*_versions.
-- created_by` is a soft FK into service-identity (the authoring staff user) —
-- never a declared foreign key into another service schema. The in-schema FKs
-- (`page_versions.page_id` / `article_versions.article_id` → their parents;
-- `articles.category_id` → `help_categories.id`; `help_categories.parent_id`
-- self-reference) live entirely within this service's own `content` schema, so
-- they are declared FKs.
--
-- Reversal plan:
--   DROP TABLE IF EXISTS "content"."article_versions";
--   DROP TABLE IF EXISTS "content"."articles";
--   DROP TABLE IF EXISTS "content"."help_categories";
--   DROP TABLE IF EXISTS "content"."page_versions";
--   DROP TABLE IF EXISTS "content"."pages";
--   DROP TYPE  IF EXISTS "content"."content_status";
--   DROP SCHEMA IF EXISTS "content";
-- Safe in isolation because no other service schema references these objects
-- (cross-service references are by id only).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-content prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "content";

-- CreateEnum
CREATE TYPE "content"."content_status" AS ENUM (
  'draft',
  'published',
  'archived'
);

-- CreateTable: live marketing / CMS pages. `current_version_id` is a SOFT
-- pointer (no FK) to the rendered `page_versions` head.
CREATE TABLE "content"."pages" (
  "id"                 TEXT                       NOT NULL,
  "slug"               TEXT                       NOT NULL,
  "status"             "content"."content_status" NOT NULL DEFAULT 'draft',
  "title"              TEXT                       NOT NULL,
  "current_version_id" TEXT,
  "created_at"         TIMESTAMPTZ(6)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6)             NOT NULL,

  CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: a page is addressed by slug, not id.
CREATE UNIQUE INDEX "pages_slug_key" ON "content"."pages"("slug");
-- CreateIndex: status-filtered admin / public view ("which pages are published").
CREATE INDEX "pages_status_idx" ON "content"."pages"("status");

-- CreateTable: append-only saved revisions of a page's body.
CREATE TABLE "content"."page_versions" (
  "id"          TEXT           NOT NULL,
  "page_id"     TEXT           NOT NULL,
  "version_no"  INTEGER        NOT NULL,
  "title"       TEXT           NOT NULL,
  "body"        TEXT           NOT NULL,
  "created_by"  TEXT           NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "page_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "page_versions_page_id_fkey"
    FOREIGN KEY ("page_id")
    REFERENCES "content"."pages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: "versions for this page" — the dominant history read.
CREATE INDEX "page_versions_page_id_idx" ON "content"."page_versions"("page_id");
-- CreateIndex: a page addresses its revisions by number; pins per-page uniqueness.
CREATE UNIQUE INDEX "page_versions_page_id_version_no_key"
  ON "content"."page_versions"("page_id", "version_no");

-- CreateTable: self-nesting help-center / blog taxonomy. `parent_id`
-- self-references for a category tree (NULL = root).
CREATE TABLE "content"."help_categories" (
  "id"         TEXT           NOT NULL,
  "slug"       TEXT           NOT NULL,
  "name"       TEXT           NOT NULL,
  "parent_id"  TEXT,
  "sort_order" INTEGER        NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "help_categories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "help_categories_parent_id_fkey"
    FOREIGN KEY ("parent_id")
    REFERENCES "content"."help_categories"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex: a category is addressed by slug, not id.
CREATE UNIQUE INDEX "help_categories_slug_key" ON "content"."help_categories"("slug");
-- CreateIndex: "child categories of this parent" — the tree-walk read.
CREATE INDEX "help_categories_parent_id_idx" ON "content"."help_categories"("parent_id");

-- CreateTable: live blog / help articles. `category_id` → help_categories
-- (NULL for an uncategorised blog post); `current_version_id` is a SOFT pointer
-- (no FK) to the rendered `article_versions` head.
CREATE TABLE "content"."articles" (
  "id"                 TEXT                       NOT NULL,
  "slug"               TEXT                       NOT NULL,
  "status"             "content"."content_status" NOT NULL DEFAULT 'draft',
  "title"              TEXT                       NOT NULL,
  "category_id"        TEXT,
  "current_version_id" TEXT,
  "created_at"         TIMESTAMPTZ(6)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6)             NOT NULL,

  CONSTRAINT "articles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "articles_category_id_fkey"
    FOREIGN KEY ("category_id")
    REFERENCES "content"."help_categories"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex: an article is addressed by slug, not id.
CREATE UNIQUE INDEX "articles_slug_key" ON "content"."articles"("slug");
-- CreateIndex: status-filtered admin / public view ("which articles are published").
CREATE INDEX "articles_status_idx" ON "content"."articles"("status");
-- CreateIndex: "articles in this category" — the help-center category-page read.
CREATE INDEX "articles_category_id_idx" ON "content"."articles"("category_id");

-- CreateTable: append-only saved revisions of an article's body.
CREATE TABLE "content"."article_versions" (
  "id"          TEXT           NOT NULL,
  "article_id"  TEXT           NOT NULL,
  "version_no"  INTEGER        NOT NULL,
  "title"       TEXT           NOT NULL,
  "body"        TEXT           NOT NULL,
  "created_by"  TEXT           NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "article_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "article_versions_article_id_fkey"
    FOREIGN KEY ("article_id")
    REFERENCES "content"."articles"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: "versions for this article" — the dominant history read.
CREATE INDEX "article_versions_article_id_idx" ON "content"."article_versions"("article_id");
-- CreateIndex: an article addresses its revisions by number; pins per-article uniqueness.
CREATE UNIQUE INDEX "article_versions_article_id_version_no_key"
  ON "content"."article_versions"("article_id", "version_no");
