-- TS-254 — Cooking Academy quiz engine.
--
-- Forward-compatible expand-only migration (CLAUDE.md §4.1): adds the quiz
-- engine's two enums + five tables to the existing `academy` schema. Touches
-- none of the TS-250 tables except to reference `academy_lessons("id")` from
-- the new `academy_quizzes` (a 1:1 quiz-per-lesson FK).
--
-- New objects (PRD §9.2–§9.3 "Quizzes and assessments"; PDD §15.1):
--   - academy_quiz_question_kind / academy_quiz_attempt_status (enums)
--   - academy_quizzes                  (1:1 with a quiz-kind academy_lessons row;
--                                        selection N + scoring threshold + retake
--                                        policy + bank_version)
--   - academy_quiz_questions           (in-service FK → academy_quizzes; CATALOG,
--                                        soft-deletable — removed from the draw
--                                        pool while preserved for history)
--   - academy_quiz_question_options    (in-service FK → academy_quiz_questions;
--                                        CATALOG; is_correct grades the answer)
--   - academy_quiz_attempts            (in-service FK → academy_quizzes; PER-STUDENT;
--                                        freezes the drawn question_ids + bank_version)
--   - academy_quiz_attempt_answers     (in-service FK → academy_quiz_attempts;
--                                        PER-STUDENT; the graded answer rows)
--
-- onDelete posture mirrors the catalog tree (TS-250): structural children
-- cascade (academy_quizzes → academy_lessons; academy_quiz_questions →
-- academy_quizzes; academy_quiz_question_options → academy_quiz_questions;
-- academy_quiz_attempt_answers → academy_quiz_attempts), while attempt records
-- are preserved via the default RESTRICT (academy_quiz_attempts →
-- academy_quizzes). In practice questions are soft-deleted, so the
-- question/option cascade is defence-in-depth.
--
-- Cross-service references are by id only (CLAUDE.md §2.3): `student_user_id`
-- on academy_quiz_attempts is a soft FK into `identity.users.id` (no SQL FK).
-- The `question_id` column on academy_quiz_attempt_answers intentionally carries
-- NO FK — an answer must keep resolving its question text even after the
-- question is soft-deleted from the bank.
--
-- Reversal plan:
--   DROP TABLE "academy"."academy_quiz_attempt_answers";
--   DROP TABLE "academy"."academy_quiz_attempts";
--   DROP TABLE "academy"."academy_quiz_question_options";
--   DROP TABLE "academy"."academy_quiz_questions";
--   DROP TABLE "academy"."academy_quizzes";
--   DROP TYPE  "academy"."academy_quiz_attempt_status";
--   DROP TYPE  "academy"."academy_quiz_question_kind";
-- Safe in isolation — no other service schema references these objects
-- (cross-service references are by id only). Drop tables children-before-parents
-- as listed.
--
-- Migration was authored by hand to match prisma/schema.prisma exactly.
-- Apply locally with:
--   pnpm -F @taste-and-see/service-academy prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

-- CreateEnum
CREATE TYPE "academy"."academy_quiz_question_kind" AS ENUM (
  'single_choice',
  'multiple_choice',
  'true_false'
);

-- CreateEnum
CREATE TYPE "academy"."academy_quiz_attempt_status" AS ENUM (
  'in_progress',
  'submitted'
);

-- CreateTable
CREATE TABLE "academy"."academy_quizzes" (
  "id"                      TEXT           NOT NULL,
  "lesson_id"               TEXT           NOT NULL,
  "title"                   TEXT           NOT NULL,
  "instructions"            TEXT,
  "questions_per_attempt"   INTEGER        NOT NULL,
  "passing_score_percent"   INTEGER        NOT NULL,
  "max_attempts"            INTEGER,
  "retake_cooldown_minutes" INTEGER,
  "shuffle_questions"       BOOLEAN        NOT NULL DEFAULT true,
  "bank_version"            INTEGER        NOT NULL DEFAULT 1,
  "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "academy_quizzes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy"."academy_quiz_questions" (
  "id"            TEXT                                    NOT NULL,
  "quiz_id"       TEXT                                    NOT NULL,
  "prompt"        TEXT                                    NOT NULL,
  "kind"          "academy"."academy_quiz_question_kind"  NOT NULL,
  "points"        INTEGER                                 NOT NULL DEFAULT 1,
  "sort_position" INTEGER                                 NOT NULL,
  "created_at"    TIMESTAMPTZ(6)                          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6)                          NOT NULL,
  "deleted_at"    TIMESTAMPTZ(6),

  CONSTRAINT "academy_quiz_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy"."academy_quiz_question_options" (
  "id"            TEXT           NOT NULL,
  "question_id"   TEXT           NOT NULL,
  "label"         TEXT           NOT NULL,
  "is_correct"    BOOLEAN        NOT NULL DEFAULT false,
  "sort_position" INTEGER        NOT NULL,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "academy_quiz_question_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy"."academy_quiz_attempts" (
  "id"              TEXT                                    NOT NULL,
  "quiz_id"         TEXT                                    NOT NULL,
  "student_user_id" TEXT                                    NOT NULL,
  "status"          "academy"."academy_quiz_attempt_status" NOT NULL DEFAULT 'in_progress',
  "attempt_number"  INTEGER                                 NOT NULL,
  "bank_version"    INTEGER                                 NOT NULL,
  "question_ids"    TEXT[],
  "points_awarded"  INTEGER,
  "points_possible" INTEGER,
  "score_percent"   INTEGER,
  "passed"          BOOLEAN,
  "started_at"      TIMESTAMPTZ(6)                          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submitted_at"    TIMESTAMPTZ(6),
  "created_at"      TIMESTAMPTZ(6)                          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(6)                          NOT NULL,

  CONSTRAINT "academy_quiz_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy"."academy_quiz_attempt_answers" (
  "id"                  TEXT           NOT NULL,
  "attempt_id"          TEXT           NOT NULL,
  "question_id"         TEXT           NOT NULL,
  "selected_option_ids" TEXT[],
  "correct"             BOOLEAN        NOT NULL,
  "points_awarded"      INTEGER        NOT NULL,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "academy_quiz_attempt_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "academy_quizzes_lesson_id_key" ON "academy"."academy_quizzes"("lesson_id");

-- CreateIndex
CREATE INDEX "academy_quiz_questions_quiz_sort_idx" ON "academy"."academy_quiz_questions"("quiz_id", "sort_position");
CREATE INDEX "academy_quiz_questions_deleted_at_idx" ON "academy"."academy_quiz_questions"("deleted_at");

-- CreateIndex
CREATE INDEX "academy_quiz_question_options_question_sort_idx" ON "academy"."academy_quiz_question_options"("question_id", "sort_position");

-- CreateIndex
CREATE INDEX "academy_quiz_attempts_student_quiz_idx" ON "academy"."academy_quiz_attempts"("student_user_id", "quiz_id");
CREATE INDEX "academy_quiz_attempts_quiz_id_idx" ON "academy"."academy_quiz_attempts"("quiz_id");

-- CreateIndex
CREATE INDEX "academy_quiz_attempt_answers_attempt_id_idx" ON "academy"."academy_quiz_attempt_answers"("attempt_id");

-- AddForeignKey
ALTER TABLE "academy"."academy_quizzes"
  ADD CONSTRAINT "academy_quizzes_lesson_id_fkey"
  FOREIGN KEY ("lesson_id") REFERENCES "academy"."academy_lessons"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy"."academy_quiz_questions"
  ADD CONSTRAINT "academy_quiz_questions_quiz_id_fkey"
  FOREIGN KEY ("quiz_id") REFERENCES "academy"."academy_quizzes"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy"."academy_quiz_question_options"
  ADD CONSTRAINT "academy_quiz_question_options_question_id_fkey"
  FOREIGN KEY ("question_id") REFERENCES "academy"."academy_quiz_questions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy"."academy_quiz_attempts"
  ADD CONSTRAINT "academy_quiz_attempts_quiz_id_fkey"
  FOREIGN KEY ("quiz_id") REFERENCES "academy"."academy_quizzes"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy"."academy_quiz_attempt_answers"
  ADD CONSTRAINT "academy_quiz_attempt_answers_attempt_id_fkey"
  FOREIGN KEY ("attempt_id") REFERENCES "academy"."academy_quiz_attempts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
