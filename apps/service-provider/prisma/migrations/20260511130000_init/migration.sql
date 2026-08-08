-- TS-050 — initial provider schema.
--
-- Creates the `provider` Postgres schema and the core `providers`
-- profile table — the row that backs every chef / culinary-companion /
-- caregiver listing on the platform — plus the two enums
-- (`provider_status`, `provider_tier`) and four indexes covering the hot
-- read paths (user lookup, admin status queue, search tier facet,
-- soft-delete filter).
--
-- Forward-compatible: subsequent migrations add (never repurpose) per
-- CLAUDE.md §4.1. Sensitive material (DOB-for-KYC, background-check
-- artefacts, Stripe Connect account) lives in other services or arrives
-- as sibling tables in future migrations (see schema.prisma header).
--
-- Reversal plan:
--   DROP TABLE "provider"."providers";
--   DROP TYPE  "provider"."provider_tier";
--   DROP TYPE  "provider"."provider_status";
--   DROP SCHEMA "provider";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-provider prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "provider";

-- CreateEnum
CREATE TYPE "provider"."provider_status" AS ENUM (
  'pending',
  'in_review',
  'active',
  'suspended',
  'archived'
);

-- CreateEnum
CREATE TYPE "provider"."provider_tier" AS ENUM (
  'basic',
  'certified',
  'elite'
);

-- CreateTable
CREATE TABLE "provider"."providers" (
  "id"                  TEXT                            NOT NULL,
  "user_id"             TEXT                            NOT NULL,
  "status"              "provider"."provider_status"    NOT NULL DEFAULT 'pending',
  "tier"                "provider"."provider_tier"      NOT NULL DEFAULT 'basic',
  "display_name"        TEXT                            NOT NULL,
  "headline"            TEXT,
  "bio"                 TEXT,
  "profile_photo_key"   TEXT,
  "video_intro_key"     TEXT,
  "time_zone"           TEXT                            NOT NULL,
  "created_at"          TIMESTAMPTZ(6)                  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6)                  NOT NULL,
  "deleted_at"          TIMESTAMPTZ(6),

  CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Unique on user_id: at most one provider profile per identity user.
-- Mirrors the application-layer invariant; the DB-level guard prevents
-- accidental double-create races during the TS-051 application flow.
CREATE UNIQUE INDEX "providers_user_id_key"      ON "provider"."providers"("user_id");
CREATE INDEX        "providers_status_idx"       ON "provider"."providers"("status");
CREATE INDEX        "providers_tier_idx"         ON "provider"."providers"("tier");
CREATE INDEX        "providers_deleted_at_idx"   ON "provider"."providers"("deleted_at");
