-- TS-142-followup-1 — outbox table for service-provider (PDD §7.3, CLAUDE.md §5.3).
--
-- Forward-only expand migration. Creates the canonical `outbox_events`
-- table in the `provider` schema. No mutations to existing rows;
-- no destructive DDL. The shape is identical to service-subscription's
-- outbox migration (20260513210000_outbox_events) — the
-- `@taste-and-see/nest-outbox` SDK is schema-agnostic and works
-- against any service that ships this exact column set
-- (CLAUDE.md §4.1).
--
-- Producer-side flow. Service-provider's `ProviderCertificationsService`
-- and `TierPromotionService` (TS-052) call
-- `OutboxService.append(tx, { eventName: 'provider.tier_changed', ... })`
-- inside the same Prisma `$transaction` as the underlying
-- write (`provider.providers.tier` update + `provider.provider_tier_history`
-- insert). The row commits atomically with the state change so a
-- transaction rollback never leaves an orphan event (PDD §7.3 outbox
-- invariant).
--
-- Relay-side flow. `apps/workers/outbox-relay` polls
-- `provider.outbox_events WHERE dispatched_at IS NULL` once
-- `OUTBOX_SOURCES` is updated additively to include
-- `provider.outbox_events`. The relay pushes each row to
-- `events:{event_name}` on Redis Streams and stamps `dispatched_at`.
-- Consumers (initially `apps/workers/search-indexer` — TS-053) dedupe
-- on `event_id` (at-least-once delivery semantics).
--
-- Reversal plan:
--   DROP INDEX IF EXISTS "provider"."outbox_events_undispatched_idx";
--   DROP INDEX IF EXISTS "provider"."outbox_events_event_name_idx";
--   DROP TABLE IF EXISTS "provider"."outbox_events";
-- Safe in isolation because no other service schema references this
-- table (the relay reads via its own `pg` pool; cross-service refs
-- are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match `prisma/schema.prisma` exactly
-- AND to materialise the partial index that Prisma's `@@index` syntax
-- cannot directly express. Apply locally with:
--   pnpm -F @taste-and-see/service-provider prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- CreateTable: outbox event row
CREATE TABLE "provider"."outbox_events" (
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
    ON "provider"."outbox_events" ("event_name");

-- CreateIndex (partial): the relay's dominant query — "give me the
-- next batch of undispatched rows ordered by created_at". The partial
-- predicate keeps the index footprint bounded against an
-- ever-growing table because at steady state most rows have a
-- non-null `dispatched_at` (CLAUDE.md §7.3 — partial indexes for
-- status-filtered queries). Prisma's `@@index` syntax cannot directly
-- express the partial predicate, so the index is materialised here.
CREATE INDEX "outbox_events_undispatched_idx"
    ON "provider"."outbox_events" ("created_at")
    WHERE "dispatched_at" IS NULL;
