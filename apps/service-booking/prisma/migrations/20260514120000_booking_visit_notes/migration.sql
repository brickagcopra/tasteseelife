-- TS-062 — booking visit notes (wellness observation per visit).
--
-- Forward-only expand migration. Adds the `booking_visit_notes`
-- sibling table keyed UNIQUE on `booking_id` so every booking has
-- at most one visit-notes row. PRD §6.4 / §7.4 / §6.9 — the visit
-- notes drive the family peace-of-mind dashboard, the provider visit
-- workflow, and the monthly wellness summary email. PDD §8.2 column
-- inventory + PDD §9.2 lifecycle sequence.
--
-- Four new enums bound the structured wellness observation columns.
-- Coarse-grained 5-point ordinals — the product choice is intentional
-- per CLAUDE.md §12 ("hospitality, not clinical"): fine-grained
-- numeric scoring would push the platform toward clinical language.
-- The columns themselves are nullable so partial saves are valid;
-- the contract layer's `.superRefine` rejects a fully-empty payload
-- at the wire so the DB row never holds the degenerate all-null
-- shape.
--
-- Forward-compatible: every new column is nullable or carries a
-- DEFAULT, so the implied empty `booking_visit_notes` "shape" (no
-- rows yet — sibling-table additive change) preserves existing
-- bookings (CLAUDE.md §4.1).
--
-- Reversal plan:
--   DROP TABLE "booking"."booking_visit_notes";
--   DROP TYPE  "booking"."visit_note_social_engagement";
--   DROP TYPE  "booking"."visit_note_hydration";
--   DROP TYPE  "booking"."visit_note_appetite";
--   DROP TYPE  "booking"."visit_note_mood";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match `prisma/schema.prisma`
-- exactly. Apply locally with:
--   pnpm -F @taste-and-see/service-booking prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

-- CreateEnum: visit-note mood (coarse 5-point ordinal).
CREATE TYPE "booking"."visit_note_mood" AS ENUM (
  'low',
  'subdued',
  'neutral',
  'bright',
  'joyful'
);

-- CreateEnum: visit-note appetite (coarse 5-point ordinal).
CREATE TYPE "booking"."visit_note_appetite" AS ENUM (
  'none',
  'minimal',
  'moderate',
  'hearty',
  'robust'
);

-- CreateEnum: visit-note hydration (coarse 5-point ordinal).
CREATE TYPE "booking"."visit_note_hydration" AS ENUM (
  'poor',
  'light',
  'adequate',
  'good',
  'excellent'
);

-- CreateEnum: visit-note social engagement (coarse 5-point ordinal).
CREATE TYPE "booking"."visit_note_social_engagement" AS ENUM (
  'withdrawn',
  'reserved',
  'present',
  'engaged',
  'vibrant'
);

-- CreateTable: one visit-notes row per booking.
CREATE TABLE "booking"."booking_visit_notes" (
  "id"                  TEXT                                          NOT NULL,
  "booking_id"          TEXT                                          NOT NULL,
  "mood"                "booking"."visit_note_mood",
  "appetite"            "booking"."visit_note_appetite",
  "hydration"           "booking"."visit_note_hydration",
  "social_engagement"   "booking"."visit_note_social_engagement",
  "freeform"            TEXT,
  "photo_keys"          TEXT[]                                        NOT NULL DEFAULT ARRAY[]::TEXT[],
  "recorded_by_user_id" TEXT                                          NOT NULL,
  "recorded_at"         TIMESTAMPTZ(6)                                NOT NULL,
  "created_at"          TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6)                                NOT NULL,

  CONSTRAINT "booking_visit_notes_pkey" PRIMARY KEY ("id"),

  -- Defence-in-depth length cap on the freeform field — the contract
  -- layer rejects payloads beyond 2000 chars; the DB check rejects a
  -- stray non-contract write (e.g. an admin tool one day) that
  -- bypasses the contract pipe.
  CONSTRAINT "booking_visit_notes_freeform_len_chk"
    CHECK ( "freeform" IS NULL OR char_length("freeform") <= 2000 ),

  -- Defence-in-depth cap on photo_keys array size (12 keys max).
  CONSTRAINT "booking_visit_notes_photo_keys_count_chk"
    CHECK ( array_length("photo_keys", 1) IS NULL OR array_length("photo_keys", 1) <= 12 )
);

-- CreateIndex (unique) — one visit-notes row per booking. The
-- service-layer upsert relies on this constraint to dedupe; without
-- it, a concurrent double-PUT could land two rows for the same
-- booking. Powers the `findUnique({ bookingId })` read path.
CREATE UNIQUE INDEX "booking_visit_notes_booking_id_unique_idx"
  ON "booking"."booking_visit_notes" ("booking_id");
