-- TS-304 — trust & safety booking holds (PRD §10.14; PDD §16.1;
-- CLAUDE.md §5.3, §12).
--
-- Forward-only EXPAND migration (CLAUDE.md §4.1). Three additive pieces,
-- none of which touches an existing column's type or nullability:
--
--   1. `bookings.held_by_incident_id` + `bookings.held_at` — the per-row
--      suspension marker, plus a CHECK pinning the two together and a
--      PARTIAL index for the release sweep.
--   2. `booking.booking_subject_holds` — the per-(incident, subject)
--      authority for "is this subject under a hold right now", which is
--      the question `createBooking` has to ask before any booking row
--      exists.
--   3. `booking.outbox_consumer_dedup` — service-booking's first
--      consumer-side dedup table. It was producer-only until now.
--
-- Why a HOLD COLUMN and not a `BookingStatus` value. `held` is not
-- mutually exclusive with what a booking already is: a held booking is
-- still `pending` or `confirmed` and returns to exactly that state when
-- the hold lifts. A status would also mean editing the frozen
-- `BOOKING_STATUS_TRANSITIONS` matrix (exhaustive from×to tests, plus
-- `TERMINAL_BOOKING_STATUSES` derived from it). A suspension is an
-- orthogonal axis, so it gets an orthogonal column.
--
-- Why a SEPARATE subject-hold table rather than deriving holds from the
-- `bookings` rows. Derivation silently allows a new booking for a
-- suspended provider whose existing visits had all completed, or for a
-- household that had none — the exact case the hold exists to stop.
--
-- Idempotency posture (CLAUDE.md §5.3). The domain-level guard is
-- `booking_subject_holds.(source_event_id, subject_kind)` UNIQUE plus the
-- (incident, subject) UNIQUE; the SDK's `outbox_consumer_dedup` table is
-- the secondary. A truncated dedup table cannot double-apply a hold.
--
-- Backfill: NONE required. Every existing `bookings` row is un-held
-- (both new columns NULL), which is the correct starting state — no
-- incident has requested a hold before this migration existed. Holds
-- accrue from the first `trust_safety.booking_hold.requested` onward.
-- Note the deliberate consequence: incidents already open at deploy time
-- do NOT retroactively suspend bookings (their `.requested` was never
-- published). Operators re-open or re-file if a live concern needs a hold
-- — a backfill that manufactured suspensions from historical severities
-- would freeze visits nobody reviewed.
--
-- Reversal plan (safe, in this order):
--   DROP INDEX IF EXISTS "booking"."booking_outbox_consumer_dedup_dead_lettered_idx";
--   DROP TABLE IF EXISTS "booking"."outbox_consumer_dedup";
--   DROP INDEX IF EXISTS "booking"."booking_subject_holds_active_subject_idx";
--   DROP INDEX IF EXISTS "booking"."booking_subject_holds_source_event_kind_unique_idx";
--   DROP INDEX IF EXISTS "booking"."booking_subject_holds_incident_idx";
--   DROP TABLE IF EXISTS "booking"."booking_subject_holds";
--   DROP TYPE  IF EXISTS "booking"."booking_subject_hold_kind";
--   DROP INDEX IF EXISTS "booking"."bookings_held_by_incident_idx";
--   ALTER TABLE "booking"."bookings"
--     DROP CONSTRAINT IF EXISTS "bookings_held_pairing_check",
--     DROP COLUMN IF EXISTS "held_at",
--     DROP COLUMN IF EXISTS "held_by_incident_id";
-- Rolling back releases every suspension, so it is an ops decision, not a
-- routine one: prefer resolving the incidents.
--
-- Apply locally with:
--   pnpm -F @taste-and-see/service-booking prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- ── 1. The per-booking suspension marker ────────────────────────────────

ALTER TABLE "booking"."bookings"
    ADD COLUMN "held_by_incident_id" TEXT,
    ADD COLUMN "held_at"             TIMESTAMPTZ(6);

-- A half-written hold (an id with no timestamp, or a timestamp with no
-- reason) is unrepresentable. The service always writes both together;
-- this makes a future direct-SQL fix-up unable to leave a booking
-- suspended for no recorded reason.
ALTER TABLE "booking"."bookings"
    ADD CONSTRAINT "bookings_held_pairing_check"
    CHECK (
      ("held_by_incident_id" IS NULL     AND "held_at" IS NULL)
      OR
      ("held_by_incident_id" IS NOT NULL AND "held_at" IS NOT NULL)
    );

-- PARTIAL index. Powers the release sweep ("clear every booking this
-- incident held") and the ops "what is currently suspended" read. Steady
-- state is overwhelmingly NULL, so the predicate keeps the index near
-- empty (CLAUDE.md §7.3). Prisma's `@@index` cannot express it.
--
-- EXPLAIN note: the release path is
--   UPDATE booking.bookings SET ... WHERE held_by_incident_id = $1
-- which without this index is a Seq Scan over every booking ever taken.
-- With it, an Index Scan over the handful of held rows.
CREATE INDEX "bookings_held_by_incident_idx"
    ON "booking"."bookings" ("held_by_incident_id")
    WHERE "held_by_incident_id" IS NOT NULL;

-- ── 2. The subject-hold authority ───────────────────────────────────────

CREATE TYPE "booking"."booking_subject_hold_kind" AS ENUM (
    'provider',
    'senior',
    'household'
);

CREATE TABLE "booking"."booking_subject_holds" (
    "id"               TEXT NOT NULL,
    -- Soft reference to `trust_safety.incidents.id`. No FK — cross-schema
    -- foreign keys are barred (CLAUDE.md §4.1).
    "incident_id"      TEXT NOT NULL,
    "subject_kind"     "booking"."booking_subject_hold_kind" NOT NULL,
    -- Soft reference to `provider.providers.id` /
    -- `household.seniors.id` / `household.households.id` per
    -- `subject_kind`. Same no-FK reasoning.
    "subject_id"       TEXT NOT NULL,
    "severity"         TEXT NOT NULL,
    "category"         TEXT NOT NULL,
    "held_at"          TIMESTAMPTZ(6) NOT NULL,
    "released_at"      TIMESTAMPTZ(6),
    "source_event_id"  TEXT NOT NULL,
    "release_event_id" TEXT,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_subject_holds_pkey" PRIMARY KEY ("id"),
    -- Severity/category are snapshots of the trust & safety vocabularies.
    -- CHECKed rather than enum'd so trust & safety can add a category
    -- without a `CREATE TYPE` migration on this side (the same reasoning
    -- as `bookings.cancellation_reason`). The contract is the source of
    -- truth; this is defence in depth against a garbled payload.
    CONSTRAINT "booking_subject_holds_severity_check"
      CHECK ("severity" IN ('low', 'medium', 'high', 'critical')),
    -- A release stamps BOTH the timestamp and the event id, or neither.
    CONSTRAINT "booking_subject_holds_release_pairing_check"
      CHECK (
        ("released_at" IS NULL     AND "release_event_id" IS NULL)
        OR
        ("released_at" IS NOT NULL AND "release_event_id" IS NOT NULL)
      ),
    -- A release cannot predate the hold it lifts.
    CONSTRAINT "booking_subject_holds_release_after_hold_check"
      CHECK ("released_at" IS NULL OR "released_at" >= "held_at")
);

-- The domain idempotency key (CLAUDE.md §5.3): a redelivered
-- `.requested` is a no-op even if the SDK's dedup table were wiped.
--
-- Keyed on (event, KIND), not the event alone: ONE `.requested`
-- legitimately produces up to three rows, because an incident may name a
-- provider, a senior, AND a household, each held independently. A bare
-- `source_event_id` UNIQUE would reject the second and third rows of a
-- valid hold order.
CREATE UNIQUE INDEX "booking_subject_holds_source_event_kind_unique_idx"
    ON "booking"."booking_subject_holds" ("source_event_id", "subject_kind");

-- Second guard: one hold per (incident, subject), whatever event id it
-- arrives under. Covers the case where the producer legitimately
-- re-publishes with a fresh id.
CREATE UNIQUE INDEX "booking_subject_holds_incident_subject_unique_idx"
    ON "booking"."booking_subject_holds" ("incident_id", "subject_kind", "subject_id");

-- The release sweep: every hold a given incident placed.
CREATE INDEX "booking_subject_holds_incident_idx"
    ON "booking"."booking_subject_holds" ("incident_id");

-- PARTIAL index — the hot read. `createBooking` and the recurring-series
-- create both ask "is any of these three subjects held right now", which
-- is an `released_at IS NULL` predicate by definition. Rows are never
-- deleted (a release stamps `released_at`), so without the predicate this
-- index would grow with the platform's entire incident history while only
-- the active sliver is ever queried (CLAUDE.md §7.3).
--
-- EXPLAIN note: the screening query is
--   SELECT incident_id, subject_kind, subject_id FROM booking_subject_holds
--    WHERE released_at IS NULL
--      AND (subject_kind, subject_id) IN (('provider',$1),('senior',$2),('household',$3))
-- → Bitmap Index Scan on this index, three probes, no heap scan of
-- released history.
CREATE INDEX "booking_subject_holds_active_subject_idx"
    ON "booking"."booking_subject_holds" ("subject_kind", "subject_id")
    WHERE "released_at" IS NULL;

-- ── 3. Consumer-side dedup (service-booking's first) ────────────────────
--
-- Canonical shape, column for column, as shipped by service-accounting /
-- service-analytics / service-audit / service-trust-safety. The
-- `@taste-and-see/nest-outbox-consumer` SDK is schema-agnostic.

CREATE TABLE "booking"."outbox_consumer_dedup" (
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
-- overwhelmingly `processed` rows with a NULL `dead_lettered_at`.
CREATE INDEX "booking_outbox_consumer_dedup_dead_lettered_idx"
    ON "booking"."outbox_consumer_dedup" ("consumer_group", "dead_lettered_at")
    WHERE "dead_lettered_at" IS NOT NULL;
