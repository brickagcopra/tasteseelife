-- TS-302a — outbox consumer dedup table for service-trust-safety
-- (PDD §7.3, §16.1; CLAUDE.md §5.3).
--
-- Forward-only expand migration. Creates the canonical
-- `outbox_consumer_dedup` table in the `trust_safety` schema. The shape
-- is identical, column for column, to the one every consuming service
-- ships (service-accounting, service-analytics, service-audit) — the
-- `@taste-and-see/nest-outbox-consumer` SDK is schema-agnostic and
-- works against any consumer carrying the canonical shape.
--
-- Why trust-safety becomes a consumer now. Through TS-301b this service
-- was producer-only: it appends `trust_safety.incident.created` and
-- listens to nothing. The welfare-escalation track (TS-302c/d) needs it
-- to react to a booking-side welfare signal, which means it needs a
-- consumer surface. This migration ships that surface's durable half
-- ahead of the first handler so the two land as reviewable pieces.
--
-- Idempotency posture (CLAUDE.md §5.3). This table is the SDK's
-- SECONDARY line of defence. The primary is a domain-level UNIQUE on
-- the side effect itself — for TS-302d that will be a
-- `incidents.source_event_id` UNIQUE, so that even a truncated dedup
-- table cannot double-open a welfare incident. On a welfare surface
-- that distinction matters: a duplicate incident is a duplicate SLA
-- timer and a duplicate page to on-call.
--
-- Reversal plan:
--   DROP INDEX IF EXISTS "trust_safety"."outbox_consumer_dedup_dead_lettered_idx";
--   DROP TABLE IF EXISTS "trust_safety"."outbox_consumer_dedup";
-- Safe in isolation — no other schema references this table (it is a
-- per-service implementation detail of the consumer SDK; cross-service
-- references are by id only, CLAUDE.md §2.3).
--
-- Apply locally with:
--   pnpm -F @taste-and-see/service-trust-safety prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

CREATE TABLE "trust_safety"."outbox_consumer_dedup" (
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

-- Partial index: the ops "what's stuck in the dead-letter queue"
-- surface. Steady state is overwhelmingly `processed` rows with a NULL
-- `dead_lettered_at`, so the predicate keeps the index small
-- (CLAUDE.md §7.3). Prisma's `@@index` cannot express the partial
-- predicate, so it is materialised here.
CREATE INDEX "outbox_consumer_dedup_dead_lettered_idx"
    ON "trust_safety"."outbox_consumer_dedup" ("consumer_group", "dead_lettered_at")
    WHERE "dead_lettered_at" IS NOT NULL;
