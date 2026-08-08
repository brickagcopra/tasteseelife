-- TS-250 — initial Cooking Academy schema.
--
-- Creates the `academy` Postgres schema and the six core tables
-- (PDD §7.2 service inventory entry #12, §15 Cooking Academy Subsystem;
-- PRD §9):
--   - academy_courses          (course → module → lesson catalog root)
--   - academy_course_modules    (in-service FK → academy_courses)
--   - academy_lessons           (in-service FK → academy_course_modules)
--   - academy_cohorts           (in-service FK → academy_courses)
--   - academy_enrollments       (in-service FKs → courses + cohorts; per-student)
--   - academy_certifications    (in-service FKs → courses + enrollments; per-student)
-- plus their seven enums and indexes. Forward-compatible: subsequent
-- migrations add (never repurpose) per CLAUDE.md §4.1, and enum value
-- sets grow via `ALTER TYPE … ADD VALUE` per the TS-205 / TS-220
-- convention.
--
-- Cross-service references are by id only (CLAUDE.md §2.3): no foreign
-- keys into `identity.users` (instructor / student) or `media-svc` S3
-- assets (hero image / lesson content / certificate PDF) — those are soft
-- FKs / asset keys resolved via the gateway BFF / events, never via SQL
-- JOIN. The course → module → lesson and course/cohort → enrollment →
-- certification relations ARE real FKs because every table lives in the
-- `academy` schema (CLAUDE.md §4.1 forbids FKs only ACROSS service schemas).
--
-- onDelete posture: structural catalog children cascade
-- (academy_course_modules → academy_courses, academy_lessons →
-- academy_course_modules); records are preserved via the default RESTRICT
-- (academy_cohorts / academy_enrollments / academy_certifications →
-- academy_courses; academy_certifications → academy_enrollments via
-- enrollment) or SET NULL on optional links (academy_enrollments →
-- academy_cohorts, academy_certifications → academy_enrollments). In
-- practice courses are soft-deleted, so the cascade/restrict behaviour is
-- defence-in-depth.
--
-- Reversal plan:
--   DROP TABLE "academy"."academy_certifications";
--   DROP TABLE "academy"."academy_enrollments";
--   DROP TABLE "academy"."academy_cohorts";
--   DROP TABLE "academy"."academy_lessons";
--   DROP TABLE "academy"."academy_course_modules";
--   DROP TABLE "academy"."academy_courses";
--   DROP TYPE  "academy"."academy_certification_status";
--   DROP TYPE  "academy"."academy_enrollment_status";
--   DROP TYPE  "academy"."academy_cohort_status";
--   DROP TYPE  "academy"."academy_lesson_kind";
--   DROP TYPE  "academy"."academy_course_status";
--   DROP TYPE  "academy"."academy_course_track";
--   DROP TYPE  "academy"."academy_course_kind";
--   DROP SCHEMA "academy";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only). Drop tables in
-- FK-dependency order (children before parents) as listed above.
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-academy prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL (docker-compose:
-- `pnpm infra:up` brings up postgres on 5432).

CREATE SCHEMA IF NOT EXISTS "academy";

-- CreateEnum
CREATE TYPE "academy"."academy_course_kind" AS ENUM (
  'self_paced',
  'cohort_based',
  'in_person_workshop'
);

-- CreateEnum
CREATE TYPE "academy"."academy_course_track" AS ENUM (
  'general',
  'dementia_sensitive',
  'therapeutic_meals',
  'luxury_in_home',
  'cultural_comfort_cuisine'
);

-- CreateEnum
CREATE TYPE "academy"."academy_course_status" AS ENUM (
  'draft',
  'published',
  'archived'
);

-- CreateEnum
CREATE TYPE "academy"."academy_lesson_kind" AS ENUM (
  'video',
  'reading',
  'quiz',
  'assignment'
);

-- CreateEnum
CREATE TYPE "academy"."academy_cohort_status" AS ENUM (
  'scheduled',
  'open',
  'in_progress',
  'completed',
  'canceled'
);

-- CreateEnum
CREATE TYPE "academy"."academy_enrollment_status" AS ENUM (
  'active',
  'completed',
  'dropped',
  'expired'
);

-- CreateEnum
CREATE TYPE "academy"."academy_certification_status" AS ENUM (
  'active',
  'expired',
  'revoked'
);

-- CreateTable
CREATE TABLE "academy"."academy_courses" (
  "id"                    TEXT                              NOT NULL,
  "slug"                  TEXT                              NOT NULL,
  "title"                 TEXT                              NOT NULL,
  "summary"               TEXT                              NOT NULL,
  "description"           TEXT,
  "kind"                  "academy"."academy_course_kind"   NOT NULL,
  "track"                 "academy"."academy_course_track"  NOT NULL DEFAULT 'general',
  "status"                "academy"."academy_course_status" NOT NULL DEFAULT 'draft',
  "level"                 TEXT,
  "estimated_minutes"     INTEGER,
  "hero_image_key"        TEXT,
  "passing_score_percent" INTEGER,
  "created_at"            TIMESTAMPTZ(6)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(6)                    NOT NULL,
  "deleted_at"            TIMESTAMPTZ(6),

  CONSTRAINT "academy_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy"."academy_course_modules" (
  "id"            TEXT           NOT NULL,
  "course_id"     TEXT           NOT NULL,
  "title"         TEXT           NOT NULL,
  "description"   TEXT,
  "sort_position" INTEGER        NOT NULL,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "academy_course_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy"."academy_lessons" (
  "id"               TEXT                              NOT NULL,
  "module_id"        TEXT                              NOT NULL,
  "title"            TEXT                              NOT NULL,
  "kind"             "academy"."academy_lesson_kind"   NOT NULL,
  "content_key"      TEXT,
  "body_markdown"    TEXT,
  "sort_position"    INTEGER                           NOT NULL,
  "duration_minutes" INTEGER,
  "created_at"       TIMESTAMPTZ(6)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(6)                    NOT NULL,

  CONSTRAINT "academy_lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy"."academy_cohorts" (
  "id"                 TEXT                              NOT NULL,
  "course_id"          TEXT                              NOT NULL,
  "name"               TEXT                              NOT NULL,
  "status"             "academy"."academy_cohort_status" NOT NULL DEFAULT 'scheduled',
  "starts_at"          TIMESTAMPTZ(6)                    NOT NULL,
  "ends_at"            TIMESTAMPTZ(6),
  "capacity"           INTEGER,
  "instructor_user_id" TEXT,
  "created_at"         TIMESTAMPTZ(6)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6)                    NOT NULL,
  "deleted_at"         TIMESTAMPTZ(6),

  CONSTRAINT "academy_cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy"."academy_enrollments" (
  "id"               TEXT                                  NOT NULL,
  "course_id"        TEXT                                  NOT NULL,
  "cohort_id"        TEXT,
  "student_user_id"  TEXT                                  NOT NULL,
  "status"           "academy"."academy_enrollment_status" NOT NULL DEFAULT 'active',
  "progress_percent" INTEGER                               NOT NULL DEFAULT 0,
  "enrolled_at"      TIMESTAMPTZ(6)                        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at"     TIMESTAMPTZ(6),
  "expires_at"       TIMESTAMPTZ(6),
  "created_at"       TIMESTAMPTZ(6)                        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(6)                        NOT NULL,
  "deleted_at"       TIMESTAMPTZ(6),

  CONSTRAINT "academy_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy"."academy_certifications" (
  "id"                  TEXT                                     NOT NULL,
  "student_user_id"     TEXT                                     NOT NULL,
  "course_id"           TEXT                                     NOT NULL,
  "enrollment_id"       TEXT,
  "title"               TEXT                                     NOT NULL,
  "track"               "academy"."academy_course_track"         NOT NULL,
  "status"              "academy"."academy_certification_status" NOT NULL DEFAULT 'active',
  "verification_token"  TEXT                                     NOT NULL,
  "certificate_pdf_key" TEXT,
  "issued_at"           TIMESTAMPTZ(6)                           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"          TIMESTAMPTZ(6),
  "revoked_at"          TIMESTAMPTZ(6),
  "created_at"          TIMESTAMPTZ(6)                           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6)                           NOT NULL,

  CONSTRAINT "academy_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "academy_courses_slug_key" ON "academy"."academy_courses"("slug");
CREATE INDEX "academy_courses_status_track_idx" ON "academy"."academy_courses"("status", "track");
CREATE INDEX "academy_courses_deleted_at_idx" ON "academy"."academy_courses"("deleted_at");

-- CreateIndex
CREATE INDEX "academy_course_modules_course_sort_idx" ON "academy"."academy_course_modules"("course_id", "sort_position");

-- CreateIndex
CREATE INDEX "academy_lessons_module_sort_idx" ON "academy"."academy_lessons"("module_id", "sort_position");

-- CreateIndex
CREATE INDEX "academy_cohorts_course_starts_idx" ON "academy"."academy_cohorts"("course_id", "starts_at");
CREATE INDEX "academy_cohorts_status_idx" ON "academy"."academy_cohorts"("status");
CREATE INDEX "academy_cohorts_deleted_at_idx" ON "academy"."academy_cohorts"("deleted_at");

-- CreateIndex
CREATE INDEX "academy_enrollments_student_status_idx" ON "academy"."academy_enrollments"("student_user_id", "status");
CREATE INDEX "academy_enrollments_course_id_idx" ON "academy"."academy_enrollments"("course_id");
CREATE INDEX "academy_enrollments_cohort_id_idx" ON "academy"."academy_enrollments"("cohort_id");
CREATE INDEX "academy_enrollments_deleted_at_idx" ON "academy"."academy_enrollments"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "academy_certifications_verification_token_key" ON "academy"."academy_certifications"("verification_token");
CREATE INDEX "academy_certifications_student_user_id_idx" ON "academy"."academy_certifications"("student_user_id");
CREATE INDEX "academy_certifications_course_id_idx" ON "academy"."academy_certifications"("course_id");
CREATE INDEX "academy_certifications_status_idx" ON "academy"."academy_certifications"("status");
CREATE INDEX "academy_certifications_expires_at_idx" ON "academy"."academy_certifications"("expires_at");

-- AddForeignKey
ALTER TABLE "academy"."academy_course_modules"
  ADD CONSTRAINT "academy_course_modules_course_id_fkey"
  FOREIGN KEY ("course_id") REFERENCES "academy"."academy_courses"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy"."academy_lessons"
  ADD CONSTRAINT "academy_lessons_module_id_fkey"
  FOREIGN KEY ("module_id") REFERENCES "academy"."academy_course_modules"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy"."academy_cohorts"
  ADD CONSTRAINT "academy_cohorts_course_id_fkey"
  FOREIGN KEY ("course_id") REFERENCES "academy"."academy_courses"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy"."academy_enrollments"
  ADD CONSTRAINT "academy_enrollments_course_id_fkey"
  FOREIGN KEY ("course_id") REFERENCES "academy"."academy_courses"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy"."academy_enrollments"
  ADD CONSTRAINT "academy_enrollments_cohort_id_fkey"
  FOREIGN KEY ("cohort_id") REFERENCES "academy"."academy_cohorts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy"."academy_certifications"
  ADD CONSTRAINT "academy_certifications_course_id_fkey"
  FOREIGN KEY ("course_id") REFERENCES "academy"."academy_courses"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy"."academy_certifications"
  ADD CONSTRAINT "academy_certifications_enrollment_id_fkey"
  FOREIGN KEY ("enrollment_id") REFERENCES "academy"."academy_enrollments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
