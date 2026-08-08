-- TS-020 — initial identity schema.
--
-- Creates the `identity` Postgres schema and the `users` table. Forward-
-- compatible: subsequent migrations add (never repurpose) per CLAUDE.md §4.1
-- and §5.3 (events also evolve additively).
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-identity prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "identity";

-- CreateEnum
CREATE TYPE "identity"."user_status" AS ENUM (
  'pending_verification',
  'active',
  'suspended',
  'deactivated'
);

-- CreateTable
CREATE TABLE "identity"."users" (
  "id"                TEXT                       NOT NULL,
  "email"             TEXT                       NOT NULL,
  "phone"             TEXT,
  "password_hash"     TEXT                       NOT NULL,
  "status"            "identity"."user_status"   NOT NULL DEFAULT 'pending_verification',
  "mfa_enabled"       BOOLEAN                    NOT NULL DEFAULT false,
  "email_verified_at" TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMPTZ(6)             NOT NULL,
  "deleted_at"        TIMESTAMPTZ(6),

  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "identity"."users"("email");
CREATE UNIQUE INDEX "users_phone_key" ON "identity"."users"("phone");
CREATE INDEX "users_status_idx" ON "identity"."users"("status");
CREATE INDEX "users_deleted_at_idx" ON "identity"."users"("deleted_at");
