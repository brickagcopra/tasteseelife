-- TS-042-followup-3a2 — service-notification becomes an outbox CONSUMER.
--
-- Adds `notification.outbox_consumer_dedup`, the ledger
-- `@taste-and-see/nest-outbox-consumer` uses to record which relayed events
-- this service has already applied. Shape is byte-for-byte the one the SDK
-- expects and the one `booking` / `subscription` / `trust_safety` already
-- carry; only the schema and the index name differ.
--
-- This service has never been a producer either, so unlike its siblings there
-- is no `notification.outbox_events` beside it. This is the only outbox table
-- in the schema and it is consume-only.
--
-- Idempotency note: this table is the SDK's line of defence, and unlike
-- reconciliation a notification does NOT converge — sending the same "your
-- payment failed" email twice is two emails. The DOMAIN-level guard is the
-- dispatch `idempotency_key` UNIQUE that has existed since TS-073: the
-- handler derives its key from `(eventId, recipientUserId)`, so a redelivery
-- that slips past this table still replays rather than re-sends.
--
-- EXPAND-ONLY. One new table, one new index, no existing object touched, no
-- backfill. Nothing reads it until the consumer module boots, so the
-- migration is safe to apply ahead of the image (CLAUDE.md §4.4).
--
-- Reversal plan (safe, in this order — deploy the prior image first so
-- nothing is writing to it):
--   DROP INDEX IF EXISTS "notification"."notification_outbox_consumer_dedup_dead_lettered_idx";
--   DROP TABLE IF EXISTS "notification"."outbox_consumer_dedup";
-- Rolling back loses the record of which events have been applied; the
-- dispatch idempotency key still prevents a duplicate send.

CREATE TABLE "notification"."outbox_consumer_dedup" (
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
CREATE INDEX "notification_outbox_consumer_dedup_dead_lettered_idx"
    ON "notification"."outbox_consumer_dedup" ("consumer_group", "dead_lettered_at")
    WHERE "dead_lettered_at" IS NOT NULL;
