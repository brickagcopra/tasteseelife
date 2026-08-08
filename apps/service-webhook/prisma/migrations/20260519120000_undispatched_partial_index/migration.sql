-- TS-041a-followup-1 — swap the undispatched index from composite to partial.
--
-- The original TS-041a / TS-051 migrations shipped a plain composite
--   CREATE INDEX <table>_undispatched_idx ON <table>(dispatched_at, received_at);
-- on both `webhook.stripe_processed_events` and
-- `webhook.checkr_processed_events`. The relay's read path is the
-- well-known
--   WHERE dispatched_at IS NULL ORDER BY received_at
-- shape; the leading `dispatched_at` column collapses the filter to an
-- index-only scan today, but at steady state almost every row has a
-- non-null `dispatched_at` so the composite carries dead weight that
-- grows with the table. CLAUDE.md §7.3 prescribes a partial index for
-- exactly this shape:
--   CREATE INDEX <table>_undispatched_idx ON <table>(received_at)
--   WHERE dispatched_at IS NULL;
--
-- The Checkr table is included in the same migration because its
-- doc-comment in prisma/schema.prisma explicitly names this follow-up
-- as the canonical shape for the swap ("Same partial-index follow-up
-- shape as stripe_processed_events_undispatched_idx (TS-041a-followup-1)").
-- The two indexes are structurally identical and the swap is a tight,
-- mechanical mirror; landing them in the same migration keeps the
-- doc-comment + migration history in lockstep.
--
-- Schema-of-record reconciliation. Prisma 5.x's `@@index` syntax cannot
-- directly express the partial predicate, so the `@@index([dispatchedAt,
-- receivedAt], map: "..._undispatched_idx")` declarations are removed
-- from `schema.prisma` in the same change. The partial index is
-- materialised here in the migration SQL and lives outside Prisma's
-- introspection — same pattern as `outbox_events_undispatched_idx`
-- (TS-142) and `subscriptions_dunning_grace_idx` once
-- TS-042-followup-1 lands. Without that removal, the next
-- `prisma migrate dev` would attempt to recreate the composite.
--
-- Drop-then-create ordering. The relay is not yet running against these
-- tables (Phase 1 webhook dispatch is the synchronous HTTP scaffold from
-- TS-026/TS-051; the relay arrives via TS-026-followup-1 / TS-051-followup-1
-- alongside the broader TS-142-followup-3 migration). At the time this
-- migration lands there is no live reader doing
-- `WHERE dispatched_at IS NULL ORDER BY received_at`, so the brief
-- no-index window between the DROP and the CREATE is operationally
-- acceptable. NOT using `CREATE INDEX CONCURRENTLY` because Prisma's
-- migration runner wraps each migration in a transaction and concurrent
-- index creation cannot run inside one. If volume in a future env makes
-- the in-transaction CREATE INDEX's AccessExclusive lock costly, the
-- swap can be re-applied via a hand-applied CONCURRENTLY pair against a
-- copy of the schema (well-trodden ops pattern); this migration is the
-- schema-of-record shape.
--
-- Reversal plan (manual; no automatic down-migration in Prisma):
--   DROP INDEX IF EXISTS "webhook"."stripe_processed_events_undispatched_idx";
--   DROP INDEX IF EXISTS "webhook"."checkr_processed_events_undispatched_idx";
--   CREATE INDEX "stripe_processed_events_undispatched_idx"
--     ON "webhook"."stripe_processed_events"("dispatched_at", "received_at");
--   CREATE INDEX "checkr_processed_events_undispatched_idx"
--     ON "webhook"."checkr_processed_events"("dispatched_at", "received_at");
-- Reversal also requires re-adding the two `@@index` lines in
-- `schema.prisma`. Safe in isolation — the index changes do not affect
-- any FK / CHECK constraint and no other service schema references
-- these rows (CLAUDE.md §2.3).
--
-- Apply locally with:
--   pnpm -F @taste-and-see/service-webhook prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- ── stripe_processed_events ─────────────────────────────────────────

DROP INDEX IF EXISTS "webhook"."stripe_processed_events_undispatched_idx";

CREATE INDEX "stripe_processed_events_undispatched_idx"
    ON "webhook"."stripe_processed_events" ("received_at")
    WHERE "dispatched_at" IS NULL;

-- ── checkr_processed_events ─────────────────────────────────────────

DROP INDEX IF EXISTS "webhook"."checkr_processed_events_undispatched_idx";

CREATE INDEX "checkr_processed_events_undispatched_idx"
    ON "webhook"."checkr_processed_events" ("received_at")
    WHERE "dispatched_at" IS NULL;
