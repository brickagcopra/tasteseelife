-- TS-060-followup-1 — add free-form cancellation text to `bookings`.
--
-- Forward-only expand migration. Adds `cancellation_reason_text` to
-- the existing `bookings` row. The existing `cancellation_reason`
-- column is repurposed semantically to carry the categorical reason
-- (validated against `BookingCancellationReason` at the contract
-- layer); the new column captures the free-form ops-triage detail
-- (CLAUDE.md §3.9 — never logged in plaintext).
--
-- Forward-compatible: the new column is nullable so existing rows
-- (none yet — service is pre-launch) remain valid. The semantic split
-- between categorical / free-form matches the
-- `TransitionBookingStatusRequest` schema in
-- `packages/contracts/src/http/booking.schema.ts`.
--
-- Reversal plan:
--   ALTER TABLE "booking"."bookings" DROP COLUMN "cancellation_reason_text";
-- Safe in isolation.

ALTER TABLE "booking"."bookings"
  ADD COLUMN "cancellation_reason_text" TEXT;
