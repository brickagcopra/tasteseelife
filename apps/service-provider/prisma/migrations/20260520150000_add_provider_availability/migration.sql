-- TS-203 — Provider availability (recurring weekly windows + date-keyed exclusions).
--
-- Adds one enum (`provider_availability_weekday`), two tables
-- (`provider_availability_windows`, `provider_availability_exceptions`),
-- and four indexes. The schema backs the self-service editor surface
-- (`PUT /api/v1/providers/:providerId/availability`) the web-provider
-- portal calls (TS-203), and the discovery-snapshot projection that
-- the search-indexer (TS-053) consumes for the
-- `ProviderDiscoveryDocument.availabilitySummary` field.
--
-- Forward-compatible expand-only migration (CLAUDE.md §4.1):
--
--   - The `provider_availability_weekday` enum is created fresh; no
--     existing types reference it.
--
--   - `provider_availability_windows` is a brand-new table — no
--     existing reads/writes touch it. The TS-203 service-provider
--     `AvailabilityService` is the first writer; the booking-svc
--     availability gate (TS-060 / TS-205) and the discovery snapshot
--     projection (TS-053) are the first readers.
--
--   - `provider_availability_exceptions` is also new — no existing
--     reads/writes touch it.
--
-- No data migration step needed — both tables start empty and the
-- new enum is created standalone. The web-provider editor (TS-203)
-- writes the first rows as providers declare their schedules.
--
-- Reversal plan (drop in reverse-creation order):
--
--   DROP INDEX IF EXISTS "provider"."provider_availability_exceptions_unique_idx";
--   DROP INDEX IF EXISTS "provider"."provider_availability_exceptions_provider_date_idx";
--   DROP TABLE          "provider"."provider_availability_exceptions";
--   DROP INDEX IF EXISTS "provider"."provider_availability_windows_unique_idx";
--   DROP INDEX IF EXISTS "provider"."provider_availability_windows_provider_weekday_idx";
--   DROP TABLE          "provider"."provider_availability_windows";
--   DROP TYPE           "provider"."provider_availability_weekday";
--
-- Safe in isolation — the new tables have no inbound FKs so they
-- drop cleanly. A rollback removes the TS-203 surface but leaves
-- every existing provider row intact.

-- CreateEnum: provider_availability_weekday -------------------------------
--
-- Seven lowercased English literals mirroring the contract-layer
-- `ProviderAvailabilityWeekdaySchema`. The enum is the source of
-- truth at the DB layer; the contract enum mirrors the catalog
-- because the `provider_availability_windows.weekday` column must be
-- enum-constrained for the partial-free unique index to be
-- meaningful (a TEXT column would not dedup case-insensitively).
CREATE TYPE "provider"."provider_availability_weekday" AS ENUM (
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday'
);

-- CreateTable: provider_availability_windows ------------------------------
--
-- One row per `(provider, weekday, start_time, end_time)` quadruple.
-- The provider declares "Monday 09:00–13:00, Thursday 18:00–21:00"
-- by inserting two rows. Multiple non-overlapping windows per
-- weekday are allowed (e.g. lunch + dinner shifts).
--
-- Time columns are stored as `time(0)` — minute-precision,
-- timezone-naive. The interpretation comes from the parent
-- `providers.time_zone` (an IANA string column). Booking-svc
-- availability gate composes them at query time.
--
-- The cross-window overlap predicate (Sunday 09:00–13:00 vs Sunday
-- 12:00–14:00) is NOT enforced at the DB layer — Postgres cannot
-- express it without a trigger. The contract layer rejects
-- overlapping pairs at the boundary; this index dedups exact
-- duplicates as a defence-in-depth layer.
CREATE TABLE "provider"."provider_availability_windows" (
    "id"          TEXT                                       NOT NULL,
    "provider_id" TEXT                                       NOT NULL,
    "weekday"     "provider"."provider_availability_weekday" NOT NULL,
    "start_time"  TIME(0)                                    NOT NULL,
    "end_time"    TIME(0)                                    NOT NULL,
    "created_at"  TIMESTAMPTZ(6)                             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(6)                             NOT NULL,

    CONSTRAINT "provider_availability_windows_pkey" PRIMARY KEY ("id")
);

-- Powers the dominant read path —
-- `AvailabilityService.getAvailability(providerId)` returns the full
-- set of windows for one provider, partitioned by weekday client-
-- side. The `(provider_id, weekday, start_time)` shape also serves
-- the booking-svc availability gate's "does this provider have a
-- slot covering 2026-05-21 11:30?" query with index-only scans.
--
-- EXPLAIN: `SELECT weekday, start_time, end_time FROM
-- provider_availability_windows WHERE provider_id = $1 ORDER BY
-- weekday, start_time` uses this index (no heap fetch needed for
-- the columns selected — Postgres include-style coverage emerges
-- from the index alone).
CREATE INDEX "provider_availability_windows_provider_weekday_idx"
    ON "provider"."provider_availability_windows"("provider_id", "weekday", "start_time");

-- Defence-in-depth dedup. The contract layer rejects overlapping
-- pairs at the boundary; this index catches duplicate-exact writes
-- that bypass the contract (admin tooling, repair script).
CREATE UNIQUE INDEX "provider_availability_windows_unique_idx"
    ON "provider"."provider_availability_windows"("provider_id", "weekday", "start_time", "end_time");

-- CreateTable: provider_availability_exceptions ---------------------------
--
-- One row per `(provider, exception_date)` pair. The provider
-- declares "I am not available on this date" — every recurring
-- window scheduled for that date is treated as blocked.
--
-- Date stored as PG `date` — calendar date only, no time-of-day
-- component. The interpretation is in the parent
-- `providers.time_zone`.
CREATE TABLE "provider"."provider_availability_exceptions" (
    "id"             TEXT           NOT NULL,
    "provider_id"    TEXT           NOT NULL,
    "exception_date" DATE           NOT NULL,
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_availability_exceptions_pkey" PRIMARY KEY ("id")
);

-- Powers the dominant read path —
-- `AvailabilityService.getAvailability(providerId)` returns the full
-- set of exceptions for one provider, sorted by date. The booking-
-- svc availability gate also reads with this index when resolving
-- "is YYYY-MM-DD blocked for this provider?".
CREATE INDEX "provider_availability_exceptions_provider_date_idx"
    ON "provider"."provider_availability_exceptions"("provider_id", "exception_date");

-- Defence-in-depth dedup. The contract layer rejects duplicate
-- dates at the boundary; this index catches duplicate writes that
-- bypass the contract (admin tooling, repair script).
CREATE UNIQUE INDEX "provider_availability_exceptions_unique_idx"
    ON "provider"."provider_availability_exceptions"("provider_id", "exception_date");
