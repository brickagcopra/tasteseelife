-- TS-217-prep-4c — search-correlation token on the raw booking-created landing.
--
-- `booking.created` now echoes the originating search's correlation token
-- (`searchId`, TS-217-prep-4a/4c). service-analytics captures it on the raw
-- landing table so the precise per-search query→booking attribution mart
-- (TS-217-prep-4c-followup-1) can join
-- `booking_created_events.search_id == search_events.event_id` — replacing
-- prep-3b's approximate `(household_id, time-window)` conversion funnel.
--
-- `search_id` is NULLABLE: a booking that did not arrive from a search
-- (concierge manual booking, direct-link visit) carries NULL. Additive +
-- forward-compatible expand migration (CLAUDE.md §4.1) — the column is added
-- nullable with no default backfill, so existing rows (pre-prep-4c bookings)
-- read NULL, which the attribution mart treats as "unattributed".
--
-- Cross-service reference by id only (CLAUDE.md §2.3): `search_id` is the
-- opaque `search.performed` event id, never a declared FK.
--
-- Reversal plan:
--   DROP INDEX IF EXISTS "analytics"."booking_created_events_search_id_idx";
--   ALTER TABLE "analytics"."booking_created_events" DROP COLUMN "search_id";
-- Safe in isolation — additive column, no other object depends on it.
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-analytics prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- AlterTable: add the nullable search-correlation token.
ALTER TABLE "analytics"."booking_created_events"
    ADD COLUMN "search_id" TEXT;

-- CreateIndex: the precise conversion-join key (search_id ==
-- search_events.event_id). Keeps the attribution mart's join cheap
-- (CLAUDE.md §7.3).
CREATE INDEX "booking_created_events_search_id_idx"
    ON "analytics"."booking_created_events" ("search_id");
