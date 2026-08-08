-- TS-051 — Checkr background-check webhook events.
--
-- Adds the `checkr_processed_events` table inside the existing
-- `webhook` Postgres schema. Same shape and conventions as
-- `stripe_processed_events` (TS-041a): id-PK on the third-party
-- event id, signature-verified-at column, payload jsonb,
-- dispatched_at forward-compatible with TS-142's relay query.
--
-- Forward-compatible expand-only migration. No changes to any
-- previously-existing table. New rows can be created the moment
-- the migration applies.
--
-- Reversal plan:
--   DROP INDEX IF EXISTS "webhook"."checkr_processed_events_undispatched_idx";
--   DROP INDEX IF EXISTS "webhook"."checkr_processed_events_object_received_idx";
--   DROP INDEX IF EXISTS "webhook"."checkr_processed_events_type_received_idx";
--   DROP TABLE "webhook"."checkr_processed_events";
-- Safe in isolation — no cross-table references; the existing
-- `stripe_processed_events` table is unaffected.

-- CreateTable
CREATE TABLE "webhook"."checkr_processed_events" (
    "event_id"               TEXT             NOT NULL,
    "event_type"             TEXT             NOT NULL,
    "account_id"             TEXT             NOT NULL,
    "object_kind"            TEXT             NOT NULL,
    "object_id"              TEXT             NOT NULL,
    "payload"                JSONB            NOT NULL,
    "signature_verified_at"  TIMESTAMPTZ(6)   NOT NULL,
    "received_at"            TIMESTAMPTZ(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at"          TIMESTAMPTZ(6),

    CONSTRAINT "checkr_processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex — ops query: "show me every event of type X in time
-- range Y".
CREATE INDEX "checkr_processed_events_type_received_idx"
    ON "webhook"."checkr_processed_events"("event_type", "received_at");

-- CreateIndex — ops query: "show me every event for this report id".
-- Indexed for the admin-side replay/troubleshooting flow that maps
-- "this Checkr report ran weird; what events did we receive for
-- it?" — joins on the dispatcher's persisted candidate / report ids.
CREATE INDEX "checkr_processed_events_object_received_idx"
    ON "webhook"."checkr_processed_events"("object_id", "received_at");

-- CreateIndex — relay query (TS-142 outbox + relay): "give me every
-- undispatched event oldest-first" — `WHERE dispatched_at IS NULL
-- ORDER BY received_at`. Same partial-index follow-up shape as
-- TS-041a's stripe_processed_events_undispatched_idx.
CREATE INDEX "checkr_processed_events_undispatched_idx"
    ON "webhook"."checkr_processed_events"("dispatched_at", "received_at");
