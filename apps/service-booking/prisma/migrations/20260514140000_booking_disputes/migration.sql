-- TS-065 — booking disputes (dispute resolution workflow per
-- PRD §10.5 and PDD §8.2 column inventory).
--
-- Forward-only expand migration. Adds the `booking_disputes` sibling
-- table keyed by `(booking_id, created_at)` for chronological listing
-- and `(status)` for the ops queue. Multiple disputes per booking are
-- permitted — a booking with both a billing dispute (filed by family)
-- and a property-damage dispute (filed by provider) holds two rows.
--
-- Three new enums bound the categorical fields. Two CHECK constraints
-- enforce the resolution-stamp invariant — `resolved_at` /
-- `resolved_by_user_id` MUST be set together (both null until
-- resolution, both non-null after).
--
-- Forward-compatible: sibling table — no existing rows are touched.
-- Mirrors the additive shape of TS-061 (booking_recurrence), TS-062
-- (booking_visit_notes), and TS-063 (booking_check_ins).
--
-- Reversal plan:
--   DROP TABLE "booking"."booking_disputes";
--   DROP TYPE  "booking"."booking_dispute_opener_role";
--   DROP TYPE  "booking"."booking_dispute_reason";
--   DROP TYPE  "booking"."booking_dispute_status";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match `prisma/schema.prisma`
-- exactly. Apply locally with:
--   pnpm -F @taste-and-see/service-booking prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- CreateEnum: dispute lifecycle status (4-state machine).
CREATE TYPE "booking"."booking_dispute_status" AS ENUM (
  'open',
  'under_review',
  'resolved',
  'dismissed'
);

-- CreateEnum: categorical reason bucket the dispute is filed under.
-- `welfare_concern` is first-class per CLAUDE.md §12.
CREATE TYPE "booking"."booking_dispute_reason" AS ENUM (
  'no_show',
  'late_arrival',
  'early_departure',
  'service_quality',
  'billing_dispute',
  'property_damage',
  'safety_concern',
  'welfare_concern',
  'other'
);

-- CreateEnum: opener role (categorical). Server-stamped from the
-- authenticated request context — never client-supplied.
CREATE TYPE "booking"."booking_dispute_opener_role" AS ENUM (
  'family',
  'provider',
  'admin'
);

-- CreateTable: multiple disputes per booking allowed.
CREATE TABLE "booking"."booking_disputes" (
  "id"                    TEXT                                          NOT NULL,
  "booking_id"            TEXT                                          NOT NULL,
  "opened_by_user_id"     TEXT                                          NOT NULL,
  "opened_by_role"        "booking"."booking_dispute_opener_role"       NOT NULL,
  "reason"                "booking"."booking_dispute_reason"            NOT NULL,
  "reason_detail"         TEXT,
  "status"                "booking"."booking_dispute_status"            NOT NULL DEFAULT 'open',
  "resolution_notes"      TEXT,
  "resolved_by_user_id"   TEXT,
  "resolved_at"           TIMESTAMPTZ(6),
  "created_at"            TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(6)                                NOT NULL,

  CONSTRAINT "booking_disputes_pkey" PRIMARY KEY ("id"),

  -- Resolution stamp invariant — both columns null until resolution,
  -- both non-null after. The service layer guards this; the CHECK is
  -- defence-in-depth against a stray non-contract write (e.g., a future
  -- admin SQL fix-up that bypasses the service).
  CONSTRAINT "booking_disputes_resolved_invariant_chk"
    CHECK ( ("resolved_at" IS NULL AND "resolved_by_user_id" IS NULL)
         OR ("resolved_at" IS NOT NULL AND "resolved_by_user_id" IS NOT NULL) ),

  -- A terminal-state row (resolved / dismissed) requires
  -- resolution_notes. Open / under_review rows tolerate a null. The
  -- service layer rejects an empty/missing resolution_notes on the
  -- terminal transition; this CHECK catches a stray non-contract
  -- write that bypasses the service.
  CONSTRAINT "booking_disputes_terminal_resolution_notes_chk"
    CHECK ( ("status" IN ('open', 'under_review'))
         OR ("status" IN ('resolved', 'dismissed') AND "resolution_notes" IS NOT NULL AND length("resolution_notes") > 0) )
);

-- CreateIndex — chronological list per booking. Powers the dominant
-- "show me every dispute for this booking, oldest first" read path
-- (family-portal, provider-portal, admin tooling).
CREATE INDEX "booking_disputes_booking_created_idx"
  ON "booking"."booking_disputes" ("booking_id", "created_at");

-- CreateIndex — ops queue scan ("show me open / under_review
-- disputes"). At steady state most rows are terminal so this is
-- selective; a partial-on-non-terminal index lands as a follow-up
-- if read load justifies it.
CREATE INDEX "booking_disputes_status_idx"
  ON "booking"."booking_disputes" ("status");

-- CreateIndex — "my activity" surfaces (the family-portal /
-- provider-portal "disputes I filed" view).
CREATE INDEX "booking_disputes_opened_by_user_created_idx"
  ON "booking"."booking_disputes" ("opened_by_user_id", "created_at");
