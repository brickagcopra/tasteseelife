import { z } from 'zod';

import {
  ACADEMY_QUIZ_ID_MAX_LENGTH,
  ACADEMY_QUIZ_OPTION_ID_MAX_LENGTH,
  ACADEMY_QUIZ_OPTION_LABEL_MAX_LENGTH,
  ACADEMY_QUIZ_QUESTION_ID_MAX_LENGTH,
  ACADEMY_QUIZ_QUESTION_POINTS_MAX,
  ACADEMY_QUIZ_QUESTION_POINTS_MIN,
  ACADEMY_QUIZ_QUESTION_PROMPT_MAX_LENGTH,
  ACADEMY_QUIZ_SORT_POSITION_MAX,
  AcademyQuizQuestionKindSchema,
} from './academy-quiz.schema';

/**
 * Academy quiz-attempt HTTP DTOs (TS-254; PRD §9.2–§9.3; PDD §15.1).
 *
 * The student-facing surface of the quiz engine: start an attempt (the engine
 * draws a randomized N-of-M question set), submit answers (the engine grades +
 * gates on the pass threshold), and read an attempt back. The defining property
 * vs. the authoring DTOs (`academy-quiz.schema.ts`): the **presented** question
 * shape NEVER carries `isCorrect` — a student must not be able to read the
 * answer key off the wire. Correct options are revealed only in the post-submit
 * GRADED answer shape.
 *
 * **Tenant scoping.** Attempts are per-student (`AcademyQuizAttempt` flows
 * through the TS-141 gate); the service filters every read/write by the
 * authenticated `studentUserId`. The endpoints sit behind `AccessTokenGuard`
 * (any authenticated student) — not the `academy:*` admin permissions.
 *
 * **`.strict()` everywhere** (CLAUDE.md §3.3).
 */

// ─── Bounded constants ───────────────────────────────────────────────────────

export const ACADEMY_QUIZ_ATTEMPT_ID_MAX_LENGTH = 36;
/** A submit may not carry more answers than this (bounds the drawn set). */
export const ACADEMY_QUIZ_ATTEMPT_ANSWERS_MAX = 200;
/** A single answer may not select more options than a question can hold. */
export const ACADEMY_QUIZ_ATTEMPT_SELECTED_OPTIONS_MAX = 26;

// ─── Enum ────────────────────────────────────────────────────────────────────

/** Attempt lifecycle — mirrors the `AcademyQuizAttemptStatus` Prisma enum. */
export const AcademyQuizAttemptStatusSchema = z.enum(['in_progress', 'submitted']);
export type AcademyQuizAttemptStatus = z.infer<typeof AcademyQuizAttemptStatusSchema>;

// ─── Field schemas ───────────────────────────────────────────────────────────

const AttemptIdSchema = z.string().min(1).max(ACADEMY_QUIZ_ATTEMPT_ID_MAX_LENGTH);
const QuizIdSchema = z.string().min(1).max(ACADEMY_QUIZ_ID_MAX_LENGTH);
const QuestionIdSchema = z.string().min(1).max(ACADEMY_QUIZ_QUESTION_ID_MAX_LENGTH);
const OptionIdSchema = z.string().min(1).max(ACADEMY_QUIZ_OPTION_ID_MAX_LENGTH);
const StudentUserIdSchema = z.string().min(1).max(64);
const PromptSchema = z.string().min(1).max(ACADEMY_QUIZ_QUESTION_PROMPT_MAX_LENGTH);
const OptionLabelSchema = z.string().min(1).max(ACADEMY_QUIZ_OPTION_LABEL_MAX_LENGTH);
const PointsSchema = z
  .number()
  .int()
  .min(ACADEMY_QUIZ_QUESTION_POINTS_MIN)
  .max(ACADEMY_QUIZ_QUESTION_POINTS_MAX);
const SortPositionSchema = z.number().int().min(0).max(ACADEMY_QUIZ_SORT_POSITION_MAX);
const PercentSchema = z.number().int().min(0).max(100);
const TimestampSchema = z.string().datetime({ offset: true });

// ─── Presented (student-safe) question shape — NO `isCorrect` ────────────────

/** An option as the STUDENT sees it during an attempt — no correctness flag. */
export const PresentedQuizOptionSchema = z
  .object({
    id: OptionIdSchema,
    label: OptionLabelSchema,
    sortPosition: SortPositionSchema,
  })
  .strict();
export type PresentedQuizOption = z.infer<typeof PresentedQuizOptionSchema>;

/**
 * A question as presented during an attempt — the drawn question with its
 * options, in presentation order, WITHOUT any correctness data.
 */
export const PresentedQuizQuestionSchema = z
  .object({
    id: QuestionIdSchema,
    prompt: PromptSchema,
    kind: AcademyQuizQuestionKindSchema,
    points: PointsSchema,
    options: z.array(PresentedQuizOptionSchema),
  })
  .strict();
export type PresentedQuizQuestion = z.infer<typeof PresentedQuizQuestionSchema>;

// ─── Attempt record + graded answer ──────────────────────────────────────────

/**
 * The attempt row. Scoring columns (`pointsAwarded` / `pointsPossible` /
 * `scorePercent` / `passed` / `submittedAt`) are null until the attempt is
 * `submitted`.
 */
export const AcademyQuizAttemptRecordSchema = z
  .object({
    id: AttemptIdSchema,
    quizId: QuizIdSchema,
    studentUserId: StudentUserIdSchema,
    status: AcademyQuizAttemptStatusSchema,
    attemptNumber: z.number().int().min(1),
    bankVersion: z.number().int().min(1),
    questionIds: z.array(QuestionIdSchema),
    pointsAwarded: z.number().int().min(0).nullable(),
    pointsPossible: z.number().int().min(0).nullable(),
    scorePercent: PercentSchema.nullable(),
    passed: z.boolean().nullable(),
    startedAt: TimestampSchema,
    submittedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AcademyQuizAttemptRecord = z.infer<typeof AcademyQuizAttemptRecordSchema>;

/**
 * A graded answer (post-submit). Reveals `correctOptionIds` (the answer key, now
 * safe to show) alongside the student's `selectedOptionIds`, the boolean
 * `correct` outcome, and the points awarded vs. possible for the question.
 */
export const GradedQuizAnswerSchema = z
  .object({
    questionId: QuestionIdSchema,
    prompt: PromptSchema,
    kind: AcademyQuizQuestionKindSchema,
    selectedOptionIds: z.array(OptionIdSchema),
    correctOptionIds: z.array(OptionIdSchema),
    correct: z.boolean(),
    pointsAwarded: z.number().int().min(0),
    pointsPossible: PointsSchema,
  })
  .strict();
export type GradedQuizAnswer = z.infer<typeof GradedQuizAnswerSchema>;

/**
 * The full attempt detail returned by start / submit / get. One shape, three
 * uses:
 *   - start  → `questions` = the drawn presented set; `answers` = [] (ungraded).
 *   - submit → `questions` = the drawn presented set; `answers` = graded.
 *   - get    → as above, by current status.
 */
export const AcademyQuizAttemptDetailSchema = z
  .object({
    attempt: AcademyQuizAttemptRecordSchema,
    questions: z.array(PresentedQuizQuestionSchema),
    answers: z.array(GradedQuizAnswerSchema),
  })
  .strict();
export type AcademyQuizAttemptDetail = z.infer<typeof AcademyQuizAttemptDetailSchema>;

// ─── Requests ────────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/academy/quizzes/:quizId/attempts` — start an attempt. No body
 * (the draw + policy are server-side); honour `Idempotency-Key`.
 */
export const StartQuizAttemptRequestSchema = z.object({}).strict();
export type StartQuizAttemptRequest = z.infer<typeof StartQuizAttemptRequestSchema>;

/** A single submitted answer — the student's selected options for one question. */
export const QuizAttemptAnswerInputSchema = z
  .object({
    questionId: QuestionIdSchema,
    selectedOptionIds: z
      .array(OptionIdSchema)
      .max(ACADEMY_QUIZ_ATTEMPT_SELECTED_OPTIONS_MAX)
      .superRefine((ids, ctx) => {
        if (new Set(ids).size !== ids.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate option id' });
        }
      }),
  })
  .strict();
export type QuizAttemptAnswerInput = z.infer<typeof QuizAttemptAnswerInputSchema>;

/**
 * `POST /api/v1/academy/attempts/:attemptId/submit` body. Carries one answer per
 * answered question; an unanswered drawn question scores zero. A question id not
 * in the attempt's drawn set, or a duplicate question id, is a 422. Honour
 * `Idempotency-Key`.
 */
export const SubmitQuizAttemptRequestSchema = z
  .object({
    answers: z
      .array(QuizAttemptAnswerInputSchema)
      .max(ACADEMY_QUIZ_ATTEMPT_ANSWERS_MAX)
      .superRefine((answers, ctx) => {
        const ids = answers.map((a) => a.questionId);
        if (new Set(ids).size !== ids.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate questionId in answers' });
        }
      }),
  })
  .strict();
export type SubmitQuizAttemptRequest = z.infer<typeof SubmitQuizAttemptRequestSchema>;

// ─── Response envelopes ──────────────────────────────────────────────────────

/** Attempt-detail envelope returned by start / submit / get. */
export const AcademyQuizAttemptDetailResponseSchema = z
  .object({ detail: AcademyQuizAttemptDetailSchema })
  .strict();
export type AcademyQuizAttemptDetailResponse = z.infer<
  typeof AcademyQuizAttemptDetailResponseSchema
>;

/**
 * `GET /api/v1/academy/quizzes/:quizId/attempts` response — the student's own
 * attempts at the quiz, newest first (drives the retake-policy display). Shallow
 * records (no nested questions/answers).
 */
export const AcademyQuizAttemptsListResponseSchema = z
  .object({ attempts: z.array(AcademyQuizAttemptRecordSchema) })
  .strict();
export type AcademyQuizAttemptsListResponse = z.infer<typeof AcademyQuizAttemptsListResponseSchema>;
