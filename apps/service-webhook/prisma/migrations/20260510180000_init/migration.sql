-- TS-041a — initial webhook schema.
--
-- Creates the `webhook` Postgres schema and the `stripe_processed_events`
-- table. The bounded context owns inbound third-party webhooks (Stripe
-- billing now; Checkr background checks + Twilio delivery receipts later
-- under sibling tables). PDD §7.2 service inventory entry #22.
--
-- Forward-compatible: future tables (`checkr_processed_events`,
-- `twilio_processed_events`) land as additive sibling migrations under the
-- same `webhook` schema with the same idempotency-key + signature-verified-at
-- shape (CLAUDE.md §4.4 expand-only).
--
-- Reversal plan:
--   DROP TABLE "webhook"."stripe_processed_events";
--   DROP SCHEMA "webhook";
-- Safe in isolation because no other service schema references these rows
-- (cross-service references are by id only — CLAUDE.md §2.3). The outbox
-- relay (TS-142) reads from this table but does not own its lifecycle.
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-webhook prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "webhook";

-- CreateTable
CREATE TABLE "webhook"."stripe_processed_events" (
  "event_id"               TEXT                NOT NULL,
  "event_type"             TEXT                NOT NULL,
  "api_version"            TEXT,
  "livemode"               BOOLEAN             NOT NULL,
  "request_id"             TEXT,
  "payload"                JSONB               NOT NULL,
  "signature_verified_at"  TIMESTAMPTZ(6)      NOT NULL,
  "received_at"            TIMESTAMPTZ(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatched_at"          TIMESTAMPTZ(6),

  CONSTRAINT "stripe_processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex — ops query: "show me every event of type X in time range Y".
CREATE INDEX "stripe_processed_events_type_received_idx"
  ON "webhook"."stripe_processed_events"("event_type", "received_at");

-- CreateIndex — relay query (TS-142 outbox + relay): "give me every
-- undispatched event oldest-first" — `WHERE dispatched_at IS NULL ORDER BY
-- received_at`. Leading `dispatched_at` column collapses the filter to an
-- index-only scan; `received_at` provides the order. A partial index
-- (`WHERE dispatched_at IS NULL`) would be the textbook optimisation — at
-- steady state almost every row has a non-null `dispatched_at` — but
-- Prisma 5.x's `@@index` declaration does not directly express partial
-- predicates and we want schema + migration in lockstep. Captured as
-- TS-041a-followup so a future migration can swap this for the partial
-- index once the relay is live and the index footprint matters in
-- practice.
CREATE INDEX "stripe_processed_events_undispatched_idx"
  ON "webhook"."stripe_processed_events"("dispatched_at", "received_at");
