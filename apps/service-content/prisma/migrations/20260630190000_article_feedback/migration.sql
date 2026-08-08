-- TS-287 — article feedback ("Was this helpful?") (PDD §19.3; PRD §10.10, §10.11).
--
-- Forward-only expand migration. Adds:
--   1. the `article_feedback_rating` enum (`helpful` | `not_helpful`),
--   2. `content.article_feedback` — end-user thumbs feedback, one vote per
--      (article, user).
--
-- The `article_id` FK is IN-SCHEMA (declared) and CASCADEs — feedback dies with
-- its article. `user_id` is a SOFT reference into service-identity (never a
-- declared cross-service FK, CLAUDE.md §2.3). The composite unique
-- `(article_id, user_id)` enforces one vote per user per article — a re-vote is
-- an UPSERT (flips the rating), never a duplicate row. Aggregate helpful /
-- not-helpful counts are COMPUTED on read (a count per rating), so there is no
-- denormalised counter to drift.
--
-- This is USER-FACING telemetry, not an admin mutation, so it is deliberately
-- NOT audit-logged per vote. No backfill (greenfield). All additive → zero-
-- downtime (expand → migrate → contract, CLAUDE.md §4.1).
--
-- Reversal plan (safe in isolation — the new table has no inbound FK):
--   DROP TABLE IF EXISTS "content"."article_feedback";
--   DROP TYPE  IF EXISTS "content"."article_feedback_rating";
--
-- Apply with:
--   pnpm -F @taste-and-see/service-content prisma:migrate:deploy

-- CreateEnum: the thumbs verdict.
CREATE TYPE "content"."article_feedback_rating" AS ENUM (
  'helpful',
  'not_helpful'
);

-- CreateTable: end-user "Was this helpful?" feedback. `article_id` → articles
-- (CASCADE); `user_id` is a soft service-identity reference.
CREATE TABLE "content"."article_feedback" (
  "id"         TEXT                                NOT NULL,
  "article_id" TEXT                                NOT NULL,
  "user_id"    TEXT                                NOT NULL,
  "rating"     "content"."article_feedback_rating" NOT NULL,
  "created_at" TIMESTAMPTZ(6)                      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6)                      NOT NULL,

  CONSTRAINT "article_feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "article_feedback_article_id_fkey"
    FOREIGN KEY ("article_id")
    REFERENCES "content"."articles"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: "aggregate feedback for this article" — the count-by-rating read.
CREATE INDEX "article_feedback_article_id_idx" ON "content"."article_feedback"("article_id");
-- CreateIndex: one vote per user per article — a re-vote UPSERTs on this key.
CREATE UNIQUE INDEX "article_feedback_article_id_user_id_key"
  ON "content"."article_feedback"("article_id", "user_id");
