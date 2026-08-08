-- TS-063 — booking check-ins (geo check-in / check-out per visit).
--
-- Forward-only expand migration. Adds the `booking_check_ins` sibling
-- table keyed UNIQUE on `(booking_id, kind)` so every booking has at
-- most one check-in row + one check-out row. PRD §7.4 + PDD §8.2
-- (column inventory) + PDD §9.2 (lifecycle sequence: provider check-in
-- → status=in_progress; provider check-out → status=completed).
--
-- One new enum bounds the discriminator. Two CHECK constraints clamp
-- the latitude / longitude to planetary bounds (defence-in-depth — the
-- contract layer already rejects out-of-range values; the DB constraint
-- catches a stray non-contract write from a future admin tool).
--
-- Forward-compatible: sibling table — no existing rows are touched.
-- Mirrors the additive shape of TS-061 (booking_recurrence) and TS-062
-- (booking_visit_notes).
--
-- Reversal plan:
--   DROP TABLE "booking"."booking_check_ins";
--   DROP TYPE  "booking"."booking_check_in_kind";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match `prisma/schema.prisma`
-- exactly. Apply locally with:
--   pnpm -F @taste-and-see/service-booking prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

-- CreateEnum: check-in kind discriminator.
CREATE TYPE "booking"."booking_check_in_kind" AS ENUM (
  'check_in',
  'check_out'
);

-- CreateTable: one or two check-in rows per booking.
CREATE TABLE "booking"."booking_check_ins" (
  "id"                        TEXT                                          NOT NULL,
  "booking_id"                TEXT                                          NOT NULL,
  "kind"                      "booking"."booking_check_in_kind"             NOT NULL,
  "latitude"                  DECIMAL(8, 6)                                 NOT NULL,
  "longitude"                 DECIMAL(9, 6)                                 NOT NULL,
  "location_accuracy_meters"  DECIMAL(10, 2),
  "occurred_at"               TIMESTAMPTZ(6)                                NOT NULL,
  "recorded_by_user_id"       TEXT                                          NOT NULL,
  "created_at"                TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMPTZ(6)                                NOT NULL,

  CONSTRAINT "booking_check_ins_pkey" PRIMARY KEY ("id"),

  -- Defence-in-depth planetary-bound CHECKs on latitude / longitude —
  -- the contract layer already rejects out-of-range coordinates; the
  -- DB CHECKs reject any stray non-contract write (e.g. a future admin
  -- tool, a SQL fix-up by an operator) that bypasses the contract pipe.
  CONSTRAINT "booking_check_ins_latitude_chk"
    CHECK ( "latitude" >= -90 AND "latitude" <= 90 ),
  CONSTRAINT "booking_check_ins_longitude_chk"
    CHECK ( "longitude" >= -180 AND "longitude" <= 180 ),

  -- Accuracy must be non-negative when present. Browser geolocation
  -- never produces negative accuracy; reject as defence-in-depth.
  CONSTRAINT "booking_check_ins_accuracy_nonneg_chk"
    CHECK ( "location_accuracy_meters" IS NULL OR "location_accuracy_meters" >= 0 )
);

-- CreateIndex (unique) — one check-in + one check-out per booking.
-- The service-layer record path relies on this constraint to surface a
-- typed `already_recorded` failure on a concurrent double-POST without
-- an Idempotency-Key. Powers the `findUnique({ bookingId, kind })`
-- read path used by the lifecycle gate (would-this-transition).
CREATE UNIQUE INDEX "booking_check_ins_booking_kind_unique_idx"
  ON "booking"."booking_check_ins" ("booking_id", "kind");

-- CreateIndex — chronological list scan per booking. Powers the GET
-- listing endpoint ("show me the check-ins for this booking, oldest
-- first") so the provider / admin UI doesn't need a heap sort.
CREATE INDEX "booking_check_ins_booking_occurred_idx"
  ON "booking"."booking_check_ins" ("booking_id", "occurred_at");
