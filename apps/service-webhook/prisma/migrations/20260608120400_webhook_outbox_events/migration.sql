-- TS-142-followup-1 — outbox table for service-webhook (PDD §7.3, CLAUDE.md §5.3).
--
-- Forward-only expand migration. Creates the canonical `outbox_events`
-- table in the `webhook` schema. No mutations to existing rows;
-- no destructive DDL. The shape is identical to service-subscription's
-- outbox migration (20260513210000_outbox_events), service-provider's
-- (20260516120000_outbox_events), service-identity's + service-household's
-- + service-accounting's (all 20260608120000_outbox_events), and
-- service-booking's (20260513220000_outbox_events) — the
-- `@taste-and-see/nest-outbox` SDK is schema-agnostic and works against
-- any service that ships this exact column set (CLAUDE.md §4.1). This is
-- the LAST service in the TS-142-followup-1 per-service rollout.
--
-- NOTE on the outbox surfaces in this schema. `webhook` already ships
-- per-source ingress tables — `webhook.stripe_processed_events`
-- (TS-041a) and `webhook.checkr_processed_events` (TS-051) — each with
-- its own `dispatched_at` column tracking the legacy synchronous
-- dispatch hop (TS-026 KYC). THIS table is the canonical generic
-- PRODUCER-side outbox: the rows service-webhook itself EMITS as
-- platform domain events once the per-source synchronous dispatchers
-- transition onto the relay (TS-142-followup-3 / TS-026-followup-1).
-- The two never overlap — the ingress tables record "third-party
-- events I have received + verified", this table records "platform
-- domain events I will publish onto the bus".
--
-- Producer-side flow. Webhook-side producers land in their own
-- follow-ups (e.g. the TS-026-followup-1 / TS-051-followup-1 migration
-- of the synchronous KYC / background-check dispatch hops onto the
-- relay). Each producer calls
-- `OutboxService.append(tx, { eventName, ... })` inside the same Prisma
-- `$transaction` as the ingress-table write (the row that records the
-- verified third-party event) so the outbox row commits atomically
-- with the persisted event — a transaction rollback never leaves an
-- orphan event (PDD §7.3 outbox invariant). The table ships ahead of
-- those producers so the migration review is decoupled from the
-- per-event producer work.
--
-- Relay-side flow. `apps/workers/outbox-relay` polls
-- `webhook.outbox_events WHERE dispatched_at IS NULL` once
-- `OUTBOX_SOURCES` is updated additively to include
-- `webhook.outbox_events`. The relay pushes each row to
-- `events:{event_name}` on Redis Streams and stamps `dispatched_at`.
-- Consumers dedupe on `event_id` (at-least-once delivery semantics).
--
-- Reversal plan:
--   DROP INDEX IF EXISTS "webhook"."outbox_events_undispatched_idx";
--   DROP INDEX IF EXISTS "webhook"."outbox_events_event_name_idx";
--   DROP TABLE IF EXISTS "webhook"."outbox_events";
-- Safe in isolation because no other service schema references this
-- table (the relay reads via its own `pg` pool; cross-service refs
-- are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match `prisma/schema.prisma` exactly
-- AND to materialise the partial index that Prisma's `@@index` syntax
-- cannot directly express. Apply locally with:
--   pnpm -F @taste-and-see/service-webhook prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- CreateTable: outbox event row
CREATE TABLE "webhook"."outbox_events" (
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
    ON "webhook"."outbox_events" ("event_name");

-- CreateIndex (partial): the relay's dominant query — "give me the
-- next batch of undispatched rows ordered by created_at". The partial
-- predicate keeps the index footprint bounded against an
-- ever-growing table because at steady state most rows have a
-- non-null `dispatched_at` (CLAUDE.md §7.3 — partial indexes for
-- status-filtered queries). Prisma's `@@index` syntax cannot directly
-- express the partial predicate, so the index is materialised here.
CREATE INDEX "outbox_events_undispatched_idx"
    ON "webhook"."outbox_events" ("created_at")
    WHERE "dispatched_at" IS NULL;
