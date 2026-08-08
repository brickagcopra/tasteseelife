-- TS-305d — provider performance metrics read model (PDD §8.2 the
-- `provider_metrics` line; PRD §10.14; CLAUDE.md §2.3, §5.3, §7.3).
--
-- Forward-only EXPAND migration. Three new tables in the `provider`
-- schema, no changes to any existing table, no data migration, no
-- backfill. Nothing reads these tables until the TS-305d read surface
-- ships, so applying this ahead of the code is safe and inert.
--
-- WHY THREE TABLES FOR ONE METRIC SET.
--
--   1. `outbox_consumer_dedup` — service-provider has been an outbox
--      PRODUCER since TS-050 and a consumer of nothing. A read model
--      refreshed off service-booking's domain events makes it a
--      consumer for the first time, and the `@taste-and-see/nest-
--      outbox-consumer` SDK requires this table. The shape is
--      identical, column for column, to the copy every consuming
--      service already ships (accounting, analytics, audit, booking,
--      notification, subscription, trust-safety) — the SDK is
--      schema-agnostic and works against any consumer carrying it.
--
--   2. `provider_booking_facts` — one row per booking. Counters alone
--      cannot answer two of the three figures PDD §8.2 promises:
--      a response-time percentile needs the offer instant and the
--      response instant on the SAME booking (and `booking.confirmed`
--      does not carry the offer time, so the projector must retain
--      `booking.created.occurredAt`), and a rolling window cannot be
--      decremented out of a counter without the underlying dates.
--
--   3. `provider_metrics` — the lifetime rollup, re-derived from the
--      facts on every event. It holds LIFETIME figures only: a stored
--      rolling-window number is wrong the moment the clock passes its
--      edge, because a provider who stops working generates no event
--      to trigger a recompute and keeps a flattering 90-day rate for
--      ever. Windowed figures are computed at READ time from the
--      facts. This table earns its place on the MANY-provider reads
--      (search ranking, the discovery document, a future
--      reliability-aware tier rule) where a per-provider aggregate
--      would be an N+1.
--
-- IDEMPOTENCY POSTURE (CLAUDE.md §5.3). `outbox_consumer_dedup` is the
-- SDK's SECONDARY defence and is a CACHE of processing decisions —
-- truncate it, or rename the consumer group, and every event replays.
-- The PRIMARY guard here is not a UNIQUE constraint but the shape of
-- the writes: every projection column is filled conditionally, only
-- while still unset, so a replayed event is a no-op and out-of-order
-- events converge. That is why `provider_booking_facts` has no
-- `source_event_id` UNIQUE like `incidents` does — several distinct
-- events legitimately write to one row.
--
-- INDEXES (CLAUDE.md §7.3). Every read of the facts is
-- "this provider's rows, bounded by a date", so both indexes lead with
-- `provider_id`. Two are needed rather than one because the funnel
-- figures bound on `offered_at` while the reliability figures bound on
-- `outcome_at`, and a single composite cannot serve both:
--
--   EXPLAIN ANALYSE, completion rate over a window:
--     SELECT outcome, count(*) FROM provider.provider_booking_facts
--      WHERE provider_id = $1 AND outcome_at >= $2 GROUP BY outcome;
--   -> Index Scan using provider_booking_facts_provider_outcome_idx
--      (provider_id, outcome_at) — the whole predicate is the index
--      prefix; rows with a NULL outcome_at (still in flight) are
--      skipped by the range test without being read.
--
-- No index on `provider_metrics` beyond its primary key: it is read by
-- provider id, or swept whole by a ranking job.
--
-- REVERSAL PLAN (safe in isolation — nothing outside this schema
-- references any of the three, and cross-service references are by id
-- only per CLAUDE.md §2.3):
--   DROP TABLE IF EXISTS "provider"."provider_metrics";
--   DROP INDEX IF EXISTS "provider"."provider_booking_facts_provider_offered_idx";
--   DROP INDEX IF EXISTS "provider"."provider_booking_facts_provider_outcome_idx";
--   DROP TABLE IF EXISTS "provider"."provider_booking_facts";
--   DROP INDEX IF EXISTS "provider"."outbox_consumer_dedup_dead_lettered_idx";
--   DROP TABLE IF EXISTS "provider"."outbox_consumer_dedup";
-- Dropping them loses the projection, not any source of truth — the
-- events remain in service-booking's outbox and a fresh consumer group
-- rebuilds the facts from the stream.
--
-- Apply locally with:
--   pnpm -F @taste-and-see/service-provider prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

CREATE TABLE "provider"."outbox_consumer_dedup" (
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

-- Partial index: the ops "what is stuck in the dead-letter queue"
-- surface. Steady state is overwhelmingly `processed` rows with a NULL
-- `dead_lettered_at`, so the predicate keeps the index small. Prisma's
-- `@@index` cannot express the partial predicate, so it lives here.
CREATE INDEX "outbox_consumer_dedup_dead_lettered_idx"
    ON "provider"."outbox_consumer_dedup" ("consumer_group", "dead_lettered_at")
    WHERE "dead_lettered_at" IS NOT NULL;

CREATE TABLE "provider"."provider_booking_facts" (
    "booking_id"               TEXT NOT NULL,
    "provider_id"              TEXT NOT NULL,
    "service_kind"             TEXT,
    "offered_at"               TIMESTAMPTZ(6),
    "responded_at"             TIMESTAMPTZ(6),
    "response_kind"            TEXT,
    "decline_kind"             TEXT,
    "outcome"                  TEXT,
    "outcome_at"               TIMESTAMPTZ(6),
    "cancellation_reason"      TEXT,
    "canceled_previous_status" TEXT,
    "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_booking_facts_pkey" PRIMARY KEY ("booking_id"),

    -- A response is two facts that are only meaningful together: WHEN
    -- the provider answered and WHAT they answered. Half a response is
    -- a row that silently drops out of the acceptance rate while still
    -- counting in the denominator, so the pairing is enforced here
    -- rather than trusted to the three handlers that write it.
    CONSTRAINT "provider_booking_facts_response_pair_check"
      CHECK (("responded_at" IS NULL) = ("response_kind" IS NULL)),
    CONSTRAINT "provider_booking_facts_response_kind_check"
      CHECK ("response_kind" IS NULL OR "response_kind" IN ('accepted', 'declined')),
    -- Same argument for the terminal position.
    CONSTRAINT "provider_booking_facts_outcome_pair_check"
      CHECK (("outcome_at" IS NULL) = ("outcome" IS NULL)),
    CONSTRAINT "provider_booking_facts_outcome_check"
      CHECK ("outcome" IS NULL OR "outcome" IN ('completed', 'canceled', 'declined')),
    CONSTRAINT "provider_booking_facts_decline_kind_check"
      CHECK ("decline_kind" IS NULL
             OR "decline_kind" IN ('provider_declined', 'window_expired', 'admin_declined'))
);

CREATE INDEX "provider_booking_facts_provider_outcome_idx"
    ON "provider"."provider_booking_facts" ("provider_id", "outcome_at");

CREATE INDEX "provider_booking_facts_provider_offered_idx"
    ON "provider"."provider_booking_facts" ("provider_id", "offered_at");

CREATE TABLE "provider"."provider_metrics" (
    "provider_id"                          TEXT NOT NULL,
    "bookings_offered"                     INTEGER NOT NULL DEFAULT 0,
    "bookings_accepted"                    INTEGER NOT NULL DEFAULT 0,
    "bookings_declined"                    INTEGER NOT NULL DEFAULT 0,
    "bookings_expired"                     INTEGER NOT NULL DEFAULT 0,
    "bookings_completed"                   INTEGER NOT NULL DEFAULT 0,
    "bookings_canceled_after_acceptance"   INTEGER NOT NULL DEFAULT 0,
    "response_seconds_total"               BIGINT NOT NULL DEFAULT 0,
    "response_samples"                     INTEGER NOT NULL DEFAULT 0,
    "first_observed_at"                    TIMESTAMPTZ(6),
    "last_observed_at"                     TIMESTAMPTZ(6),
    "computed_at"                          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"                           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_metrics_pkey" PRIMARY KEY ("provider_id"),

    -- Every counter is a count of rows and a recompute writes them all
    -- together, so a negative value is not a bad number, it is a bug in
    -- the recompute. Fail the write rather than serve it.
    CONSTRAINT "provider_metrics_non_negative_check"
      CHECK ("bookings_offered" >= 0
             AND "bookings_accepted" >= 0
             AND "bookings_declined" >= 0
             AND "bookings_expired" >= 0
             AND "bookings_completed" >= 0
             AND "bookings_canceled_after_acceptance" >= 0
             AND "response_seconds_total" >= 0
             AND "response_samples" >= 0)
);
