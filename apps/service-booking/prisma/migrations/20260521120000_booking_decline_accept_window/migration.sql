-- TS-205 — provider accept/decline + auto-decline window.
--
-- Adds the missing decline lifecycle states + the columns that record
-- the provider's accept window + the decline metadata. PRD §7.3
-- "Inbound booking requests with accept/decline window" + PDD §9.2.
--
-- Forward-only expand migration:
--   1. Adds `declined` to the `booking.booking_status` enum
--      (Postgres enum extension is non-transactional — must run as a
--       standalone statement; `ADD VALUE IF NOT EXISTS` keeps reruns
--       idempotent).
--   2. Adds six new nullable columns to `booking.bookings`:
--      `accept_window_expires_at` — provider response deadline.
--      `declined_at`              — terminal-state stamp.
--      `decline_kind`             — categorical kind
--                                   (provider_declined | window_expired
--                                   | admin_declined). TEXT so adding a
--                                   future value doesn't need CREATE
--                                   TYPE.
--      `decline_reason`           — categorical reason. TEXT for the
--                                   same forward-compat rationale.
--      `decline_reason_text`      — free-form ops detail (≤ 2000 char
--                                   at the contract layer).
--      `declined_by_user_id`      — actor that triggered the decline.
--   3. Adds a partial index supporting the TS-205-followup-1 auto-
--      decline scheduler's dominant query: "give me every pending
--      booking whose accept window has expired".
--
-- All columns are nullable so existing rows (already created at any
-- point in the lifecycle — pre-TS-205 bookings have no accept window)
-- remain valid. Newly-created bookings populate `accept_window_expires_at`
-- via the service-layer default. Forward-compatible per CLAUDE.md §4.1.
--
-- Reversal plan:
--   DROP INDEX IF EXISTS "booking"."bookings_accept_window_pending_idx";
--   ALTER TABLE "booking"."bookings"
--     DROP COLUMN "declined_by_user_id",
--     DROP COLUMN "decline_reason_text",
--     DROP COLUMN "decline_reason",
--     DROP COLUMN "decline_kind",
--     DROP COLUMN "declined_at",
--     DROP COLUMN "accept_window_expires_at";
--   -- Postgres can't drop a single enum value without recreating the
--   -- type. Reversing the enum addition requires:
--   --   CREATE TYPE "booking"."booking_status_old" AS ENUM (...);
--   --   ALTER TABLE "booking"."bookings"
--   --     ALTER COLUMN status TYPE "booking"."booking_status_old"
--   --     USING status::text::"booking"."booking_status_old";
--   --   DROP TYPE "booking"."booking_status";
--   --   ALTER TYPE "booking"."booking_status_old"
--   --     RENAME TO "booking_status";
--   -- Only runnable if no rows carry the `declined` value; the
--   -- service-layer gate refuses transitions out of terminal states
--   -- so the only way to clear them is the manual ops path.

-- 1. Enum extension (non-transactional — Postgres requires this
--    statement to run outside any wrapping BEGIN/COMMIT). Prisma's
--    migration runner applies each migration file in its own
--    implicit transaction; for enum extensions we set the per-
--    statement-only contract via `IF NOT EXISTS` so the migration
--    is rerunnable.
ALTER TYPE "booking"."booking_status" ADD VALUE IF NOT EXISTS 'declined';

-- 2. Decline + accept-window columns on the bookings row.
ALTER TABLE "booking"."bookings"
  ADD COLUMN "accept_window_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "declined_at"              TIMESTAMPTZ(6),
  ADD COLUMN "decline_kind"             TEXT,
  ADD COLUMN "decline_reason"           TEXT,
  ADD COLUMN "decline_reason_text"      TEXT,
  ADD COLUMN "declined_by_user_id"      TEXT;

-- 3. Partial index for the TS-205-followup-1 auto-decline scheduler's
--    dominant query: "give me every pending booking whose accept
--    window has expired so I can decline them". Partial filter keeps
--    the index footprint bounded — most rows reach `confirmed`
--    quickly so `pending` is short-lived by design.
--
-- EXPLAIN rationale: a sequential scan over the bookings table for
-- the worker's poll cycle would touch every historical row; the
-- partial index restricts to rows that are still in `pending` AND
-- have a populated window stamp (the new column is nullable so back-
-- fill rows + admin-created bookings stay out of the index).
CREATE INDEX "bookings_accept_window_pending_idx"
  ON "booking"."bookings" ("accept_window_expires_at")
  WHERE "status" = 'pending'
    AND "accept_window_expires_at" IS NOT NULL;
