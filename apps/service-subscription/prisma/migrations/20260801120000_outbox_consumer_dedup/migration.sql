-- TS-041b-followup-3a — service-subscription becomes an outbox CONSUMER.
--
-- Adds `subscription.outbox_consumer_dedup`, the ledger
-- `@taste-and-see/nest-outbox-consumer` uses to record which relayed events
-- this service has already applied. Shape is byte-for-byte the one the SDK
-- expects and the one `booking.outbox_consumer_dedup` already carries
-- (TS-304); only the schema and the index name differ.
--
-- Orthogonal to `subscription.outbox_events`, which has existed since TS-142
-- and is the PRODUCER side. Different table, different direction: that one
-- holds events this service will publish, this one holds events it has
-- consumed.
--
-- EXPAND-ONLY. One new table, one new index, no existing object touched, no
-- backfill. Nothing reads it until the consumer module boots, so the
-- migration is safe to apply ahead of the image (CLAUDE.md §4.4).
--
-- Reversal plan (safe, in this order — deploy the prior image first so
-- nothing is writing to it):
--   DROP INDEX IF EXISTS "subscription"."subscription_outbox_consumer_dedup_dead_lettered_idx";
--   DROP TABLE IF EXISTS "subscription"."outbox_consumer_dedup";
-- Rolling back loses the record of which events have been applied. That is
-- recoverable rather than dangerous: reconciliation converges, so a replayed
-- event re-reads Stripe and writes nothing when state already agrees.

CREATE TABLE "subscription"."outbox_consumer_dedup" (
    "consumer_group"    TEXT NOT NULL,
    "event_id"          TEXT NOT NULL,
    "event_name"        TEXT NOT NULL,
    "state"             TEXT NOT NULL,
    "attempts"          INTEGER NOT NULL DEFAULT 1,
    "last_error"        TEXT,
    "first_seen_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at"      TIMESTAMPTZ(6),
    "dead_lettered_at"  TIMESTAMPTZ(6),

    CONSTRAINT "outbox_consumer_dedup_pkey" PRIMARY KEY ("consumer_group", "event_id"),
    CONSTRAINT "outbox_consumer_dedup_state_check"
      CHECK ("state" IN ('in_flight', 'processed', 'dead_lettered'))
);

-- Partial index: the ops dead-letter queue view. Steady state is
-- overwhelmingly `processed` rows with a NULL `dead_lettered_at`, so a plain
-- composite would index every event this service has ever consumed in order
-- to answer a question about the handful that failed.
--
-- EXPLAIN: `WHERE consumer_group = $1 AND dead_lettered_at IS NOT NULL` plans
-- as an Index Scan over a relation that stays kilobytes wide while the table
-- grows without bound.
CREATE INDEX "subscription_outbox_consumer_dedup_dead_lettered_idx"
    ON "subscription"."outbox_consumer_dedup" ("consumer_group", "dead_lettered_at")
    WHERE "dead_lettered_at" IS NOT NULL;
