-- TS-070 — initial messaging schema.
--
-- Creates the `messaging` Postgres schema, the two enums
-- (`thread_kind`, `thread_participant_role`), the core metadata tables
-- (`threads`, `thread_participants`), and the three composite indexes
-- powering the dominant read paths from PRD §6.7 / PDD §13.1.
--
-- Forward-compatible: subsequent migrations add (never repurpose) per
-- CLAUDE.md §4.1. The Cassandra cold-side message-body store (PDD §8.3
-- keyspaces `messaging.messages_by_thread` + `messaging.message_inbox`)
-- lands as TS-070-followup-1 — it's a sibling persistence path, not a
-- schema change here.
--
-- Reversal plan:
--   DROP TABLE "messaging"."thread_participants";
--   DROP TABLE "messaging"."threads";
--   DROP TYPE  "messaging"."thread_participant_role";
--   DROP TYPE  "messaging"."thread_kind";
--   DROP SCHEMA "messaging";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-messaging prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "messaging";

-- CreateEnum
CREATE TYPE "messaging"."thread_kind" AS ENUM (
  'household',
  'booking',
  'concierge'
);

-- CreateEnum
CREATE TYPE "messaging"."thread_participant_role" AS ENUM (
  'member',
  'observer',
  'concierge'
);

-- CreateTable
CREATE TABLE "messaging"."threads" (
  "id"            TEXT                          NOT NULL,
  "kind"          "messaging"."thread_kind"     NOT NULL,
  "household_id"  TEXT,
  "booking_id"    TEXT,
  "created_at"    TIMESTAMPTZ(6)                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6)                NOT NULL,
  "archived_at"   TIMESTAMPTZ(6),

  CONSTRAINT "threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messaging"."thread_participants" (
  "thread_id"             TEXT                                      NOT NULL,
  "user_id"               TEXT                                      NOT NULL,
  "role"                  "messaging"."thread_participant_role"     NOT NULL,
  "joined_at"             TIMESTAMPTZ(6)                            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_read_message_id"  TEXT,

  CONSTRAINT "thread_participants_pkey" PRIMARY KEY ("thread_id", "user_id")
);

-- AddForeignKey
ALTER TABLE "messaging"."thread_participants"
  ADD CONSTRAINT "thread_participants_thread_id_fkey"
  FOREIGN KEY ("thread_id") REFERENCES "messaging"."threads"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
-- Powers "every thread for my household, newest first" — the family-
-- portal inbox per PRD §6.7. Partial-predicate `WHERE archived_at IS
-- NULL` is the natural follow-up once the proportion of archived
-- threads grows enough to matter; today the non-partial composite is
-- correct + cheap.
CREATE INDEX "threads_household_created_idx"
  ON "messaging"."threads"("household_id", "created_at" DESC);

-- Powers "the thread for this booking" — the booking-detail panel.
-- Booking ids are unique per booking so the index is effectively a
-- covering lookup.
CREATE INDEX "threads_booking_created_idx"
  ON "messaging"."threads"("booking_id", "created_at" DESC);

-- Powers the admin "show me every thread by kind" surface.
CREATE INDEX "threads_kind_created_idx"
  ON "messaging"."threads"("kind", "created_at" DESC);

-- Powers "every thread I'm in, newest first" — the per-user inbox
-- (sibling read path to `threads_household_created_idx`).
CREATE INDEX "thread_participants_user_joined_idx"
  ON "messaging"."thread_participants"("user_id", "joined_at" DESC);
