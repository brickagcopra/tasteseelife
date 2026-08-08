-- TS-060-followup-1 — outbox table for service-booking (PDD §7.3, CLAUDE.md §5.3).
--
-- Forward-only expand migration. Creates the canonical `outbox_events`
-- table in the `booking` schema so the BookingsService orchestration
-- can append `booking.*` domain events transactionally with the booking
-- row mutation. Shape is identical to service-subscription's
-- `subscription.outbox_events` table from TS-142 — the
-- `@taste-and-see/nest-outbox` SDK is schema-agnostic and works against
-- any service that ships this table (CLAUDE.md §4.1).
--
-- Reversal plan:
--   DROP INDEX IF EXISTS "booking"."outbox_events_undispatched_idx";
--   DROP TABLE IF EXISTS "booking"."outbox_events";
-- Safe in isolation because no other service schema references this
-- table (the relay reads via its own `pg` pool; cross-service refs are
-- by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match `prisma/schema.prisma`
-- exactly AND to materialise the partial index that Prisma's `@@index`
-- syntax cannot directly express. Apply locally with:
--   pnpm -F @taste-and-see/service-booking prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- CreateTable: outbox event row
CREATE TABLE "booking"."outbox_events" (
    "event_id"         TEXT NOT NULL,
    "event_name"       TEXT NOT NULL,
    "payload"          JSONB NOT NULL,
    "occurred_at"      TIMESTAMPTZ(6) NOT NULL,
    "producer_service" TEXT NOT NULL,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at"    TIMESTAMPTZ(6),
    "attempts"         INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at"  TIMESTAMPTZ(6),
    "last_error"       TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex: secondary scroll by event_name (admin filters / metrics).
CREATE INDEX "outbox_events_event_name_idx"
    ON "booking"."outbox_events" ("event_name");

-- CreateIndex (partial): the relay's dominant query — "give me the
-- next batch of undispatched rows ordered by created_at". The partial
-- predicate keeps the index footprint bounded against an ever-growing
-- table because at steady state most rows have a non-null
-- `dispatched_at` (CLAUDE.md §7.3 — partial indexes for status-
-- filtered queries). Prisma's `@@index` syntax cannot directly express
-- the partial predicate, so the index is materialised here.
CREATE INDEX "outbox_events_undispatched_idx"
    ON "booking"."outbox_events" ("created_at")
    WHERE "dispatched_at" IS NULL;
