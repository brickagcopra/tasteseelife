-- TS-288 — per-post newsletter send guard (PDD §12.3; PRD §10.10).
--
-- Forward-only expand migration. Adds two NULLABLE columns to `content.articles`:
--   - `newsletter_sent_at`  — set when an editor triggers "send to newsletter" on
--     a published post. The idempotency guard: a post is never double-sent to the
--     newsletter (the send endpoint 409s when this is already set). NULL = not
--     yet sent.
--   - `newsletter_sent_by`  — the soft-ref staff user id (into service-identity)
--     who triggered the send. NULL until sent. Not an FK (cross-service id,
--     CLAUDE.md §2.3 / §4.1).
--
-- The send action emits `content.newsletter.send_requested` to the transactional
-- outbox; the actual per-subscriber delivery (service-notification, marketing
-- category, CAN-SPAM opt-out) is the carved consumer TS-288-followup-1 — this
-- migration only stands up the producer-side send guard.
--
-- No backfill (a greenfield deploy has no rows; existing articles read
-- `newsletter_sent_at = NULL` = "never sent to the newsletter"). No mutations to
-- existing rows; no destructive DDL; both columns additive → zero-downtime
-- (expand → migrate → contract, CLAUDE.md §4.1).
--
-- No index: read as part of the single-article detail row, never a `where`
-- predicate at scale (CLAUDE.md §4.1 / §7.3).
--
-- Reversal plan (safe in isolation — both columns nullable, no FK / no view):
--   ALTER TABLE "content"."articles"
--     DROP COLUMN IF EXISTS "newsletter_sent_at",
--     DROP COLUMN IF EXISTS "newsletter_sent_by";
--
-- Apply with:
--   pnpm -F @taste-and-see/service-content prisma:migrate:deploy

-- AlterTable: add the nullable newsletter-send guard columns.
ALTER TABLE "content"."articles"
    ADD COLUMN "newsletter_sent_at" TIMESTAMPTZ(6),
    ADD COLUMN "newsletter_sent_by" TEXT;
