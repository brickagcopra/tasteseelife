-- TS-061 — booking recurrence (RFC 5545 RRULE subset).
--
-- Forward-only expand migration. Adds the `booking_recurrence`
-- sibling table keyed by `series_id` (the canonical recurring-series
-- id every child `bookings` row carries on its new `series_id`
-- column). PRD §6.3 calls for weekly / biweekly / monthly recurring
-- bookings; the schema is forward-compatible with the full RFC 5545
-- RRULE catalog (the expander supports a Phase-1 subset; the storage
-- is the verbatim RRULE string so future expander work lands without
-- a schema change).
--
-- Forward-compatible: every new column on `bookings` is nullable so
-- existing rows (none yet — service is pre-launch but the migration
-- is defensive) remain valid.
--
-- Reversal plan:
--   ALTER TABLE "booking"."bookings" DROP COLUMN "series_id";
--   ALTER TABLE "booking"."bookings" DROP COLUMN "series_index";
--   DROP INDEX  "booking"."bookings_series_scheduled_idx";
--   DROP INDEX  "booking"."bookings_series_index_unique_idx";
--   DROP TABLE  "booking"."booking_recurrence";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only — CLAUDE.md §2.3).

-- AlterTable — add the recurring-series columns to bookings.
ALTER TABLE "booking"."bookings"
  ADD COLUMN "series_id"    TEXT,
  ADD COLUMN "series_index" INTEGER;

-- CreateIndex — series chronological scan. Powers the family / provider
-- portals' "show me the occurrences in this series" queries (PRD §6.3).
-- Composite (series_id, scheduled_start) so the planner-style UI gets a
-- single index range scan rather than a heap sort.
CREATE INDEX "bookings_series_scheduled_idx"
  ON "booking"."bookings"("series_id", "scheduled_start");

-- CreateIndex — defence-in-depth uniqueness on (series_id, series_index).
-- The service guarantees uniqueness at the Prisma `$transaction` layer
-- (the explode-and-insert step writes positions 0..N exactly once);
-- the DB unique index closes a concurrent-re-explode race the service
-- shouldn't expose but the storage layer should reject regardless.
-- The index is naturally selective — both columns are nullable, so
-- non-recurring bookings (the dominant volume) sit outside the
-- unique-constraint scope.
CREATE UNIQUE INDEX "bookings_series_index_unique_idx"
  ON "booking"."bookings"("series_id", "series_index");

-- CreateTable
CREATE TABLE "booking"."booking_recurrence" (
  "series_id"        TEXT                            NOT NULL,
  "rrule"            VARCHAR(500)                    NOT NULL,
  "end_date"         TIMESTAMPTZ(6),
  "count"            INTEGER,
  "occurrence_count" INTEGER                         NOT NULL,
  "household_id"     TEXT                            NOT NULL,
  "senior_id"        TEXT                            NOT NULL,
  "provider_id"      TEXT                            NOT NULL,
  "created_at"       TIMESTAMPTZ(6)                  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(6)                  NOT NULL,

  CONSTRAINT "booking_recurrence_pkey" PRIMARY KEY ("series_id"),
  -- Termination invariant: every row must carry at most one of UNTIL
  -- (end_date) or COUNT. The Phase-1 expander rejects RRULEs that
  -- carry neither; a future open-ended variant would relax this CHECK.
  CONSTRAINT "booking_recurrence_termination_chk"
    CHECK ( ("end_date" IS NULL) OR ("count" IS NULL) ),
  -- Materialised-series-size invariant: every row records the count
  -- of child bookings the expander produced. Bounded 1..52 to mirror
  -- `RECURRENCE_MAX_OCCURRENCES` at the contract layer.
  CONSTRAINT "booking_recurrence_occurrence_count_chk"
    CHECK ( "occurrence_count" >= 1 AND "occurrence_count" <= 52 ),
  -- COUNT-clause invariant when present.
  CONSTRAINT "booking_recurrence_count_chk"
    CHECK ( "count" IS NULL OR ("count" >= 1 AND "count" <= 52) )
);

-- CreateIndex — household and provider scan paths for the series-
-- management surfaces in the family / provider portals (TS-121 / TS-122).
CREATE INDEX "booking_recurrence_household_created_idx"
  ON "booking"."booking_recurrence"("household_id", "created_at");

CREATE INDEX "booking_recurrence_provider_created_idx"
  ON "booking"."booking_recurrence"("provider_id", "created_at");
