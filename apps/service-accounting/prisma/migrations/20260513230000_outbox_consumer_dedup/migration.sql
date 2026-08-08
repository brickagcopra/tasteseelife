-- TS-142-followup-2-followup-2 — outbox consumer dedup table for
-- service-accounting (PDD §7.3, CLAUDE.md §5.3, §6).
--
-- Forward-only expand migration. Creates the canonical
-- `outbox_consumer_dedup` table in the `accounting` schema. The shape
-- mirrors the canonical SQL documented in the
-- `@taste-and-see/nest-outbox-consumer` `PgConsumerDedupStore` doc-
-- comment — every consuming service ships this table in its own schema
-- with the same column set (the SDK is schema-agnostic and works
-- against any consumer that ships the canonical shape).
--
-- Why service-accounting is the first consumer. TS-142 shipped the
-- producer-side SDK + the relay; TS-142-followup-9 wired
-- service-subscription to emit `subscription.activated` /
-- `subscription.canceled`. service-accounting is the first downstream
-- that needs to react to those events — it converts the activation
-- event into a `recognizeActivation` call (DR Cash / CR Deferred
-- Revenue + the per-subscription balance row) per PDD §11.2 +
-- Appendix A. The dedup table is the SDK's secondary line of defence;
-- the recognizer's `deferred_revenue_balances.source_event_id` UNIQUE
-- constraint is the primary one (CLAUDE.md §5.3 — consumers
-- idempotency-check on event_id; the handler itself stays idempotent
-- on the same key at the side-effect layer).
--
-- Reversal plan:
--   DROP INDEX IF EXISTS "accounting"."outbox_consumer_dedup_dead_lettered_idx";
--   DROP TABLE IF EXISTS "accounting"."outbox_consumer_dedup";
-- Safe in isolation because no other service schema references this
-- table (it's a per-service implementation detail of the consumer SDK;
-- cross-service refs are by id only — CLAUDE.md §2.3).
--
-- Apply locally with:
--   pnpm -F @taste-and-see/service-accounting prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- CreateTable: one row per (consumer_group, event_id). The PK is the
-- dedup key; redeliveries upsert via `ON CONFLICT (consumer_group,
-- event_id) DO UPDATE` in the SDK's `recordAttempt` path.
--
-- Column rationale:
--   - `consumer_group`   — Redis Streams consumer group name. The
--                          consuming service's name by convention
--                          (`service-accounting`).
--   - `event_id`         — Producer-stamped event id from the outbox.
--                          For subscription.activated this is
--                          `{subscriptionId}.activated`.
--   - `event_name`       — Dot-notation event name (e.g.
--                          `subscription.activated`). Captured so the
--                          dedup row is self-describing without
--                          joining back to the consumer-side handler
--                          registry.
--   - `state`            — Three-valued lifecycle:
--                            * `in_flight`    — attempt in progress or
--                                               last attempt failed.
--                            * `processed`    — handler succeeded.
--                            * `dead_lettered`— attempts exceeded
--                                               `maxAttempts`.
--   - `attempts`         — Monotonic counter; the SDK increments on
--                          every recordAttempt.
--   - `last_error`       — Most recent failure message, truncated at
--                          2000 chars by the SDK's recordFailure path.
--   - `first_seen_at`    — Wall-clock time the consumer first saw the
--                          event. Useful for SLA + lag dashboards.
--   - `last_attempt_at`  — Updated on every attempt.
--   - `processed_at`     — Stamped on success; NULL until then.
--   - `dead_lettered_at` — Stamped when state flips to dead_lettered.
--
-- The CHECK constraint pins the state enum at the database layer so
-- an ad-hoc UPDATE that drifts away from the SDK's three-valued
-- vocabulary fails-fast.
CREATE TABLE "accounting"."outbox_consumer_dedup" (
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

-- CreateIndex (partial): ops surface for dead-lettered rows. The
-- TS-142-followup-5 admin endpoint queries this index to drive the
-- "what's stuck in the dead-letter queue" UI. Partial predicate
-- keeps the index small at steady state — the vast majority of rows
-- are `processed` and don't carry a `dead_lettered_at` timestamp
-- (CLAUDE.md §7.3 — partial indexes for status-filtered queries).
-- Prisma's `@@index` cannot directly express the partial predicate;
-- the index is materialised here.
CREATE INDEX "outbox_consumer_dedup_dead_lettered_idx"
    ON "accounting"."outbox_consumer_dedup" ("consumer_group", "dead_lettered_at")
    WHERE "dead_lettered_at" IS NOT NULL;
