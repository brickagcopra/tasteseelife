-- TS-271a-followup-1 / TS-272a-followup-1 / TS-277a-followup-1 — outbox
-- consumer dedup table for service-audit (PDD §7.3, CLAUDE.md §5.3, §6).
--
-- Forward-only expand migration. Creates the canonical
-- `outbox_consumer_dedup` table in the `audit` schema. The shape mirrors the
-- canonical SQL documented in the `@taste-and-see/nest-outbox-consumer`
-- `PgConsumerDedupStore` doc-comment — every consuming service ships this
-- table in its own schema with the same column set (the SDK is schema-agnostic
-- and works against any consumer that ships the canonical shape).
--
-- service-audit is the consumer that turns the platform's
-- `audit.action_recorded` events (emitted by every producer's outbox, drained
-- onto Redis Streams by the worker-outbox-relay) into append-only,
-- hash-chained `audit_events` rows via `AuditService.recordEvent`. The dedup
-- table is the SDK's secondary line of defence against redelivery; the primary
-- is `audit_events.event_id` UNIQUE (CLAUDE.md §5.3 — consumers idempotency-
-- check on event_id; the handler itself stays idempotent on the same key).
--
-- Reversal plan:
--   DROP INDEX IF EXISTS "audit"."outbox_consumer_dedup_dead_lettered_idx";
--   DROP TABLE IF EXISTS "audit"."outbox_consumer_dedup";
-- Safe in isolation because no other service schema references this table
-- (it's a per-service implementation detail of the consumer SDK; cross-service
-- refs are by id only — CLAUDE.md §2.3).
--
-- Apply locally with:
--   pnpm -F @taste-and-see/service-audit prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- CreateTable: one row per (consumer_group, event_id). The PK is the dedup
-- key; redeliveries upsert via `ON CONFLICT (consumer_group, event_id) DO
-- UPDATE` in the SDK's `recordAttempt` path. The CHECK constraint pins the
-- state enum at the database layer so an ad-hoc UPDATE that drifts away from
-- the SDK's three-valued vocabulary fails-fast.
CREATE TABLE "audit"."outbox_consumer_dedup" (
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

-- CreateIndex (partial): ops surface for dead-lettered rows. Partial predicate
-- keeps the index small at steady state — the vast majority of rows are
-- `processed` and don't carry a `dead_lettered_at` timestamp (CLAUDE.md §7.3 —
-- partial indexes for status-filtered queries). Prisma's `@@index` cannot
-- directly express the partial predicate; the index is materialised here.
CREATE INDEX "outbox_consumer_dedup_dead_lettered_idx"
    ON "audit"."outbox_consumer_dedup" ("consumer_group", "dead_lettered_at")
    WHERE "dead_lettered_at" IS NOT NULL;
