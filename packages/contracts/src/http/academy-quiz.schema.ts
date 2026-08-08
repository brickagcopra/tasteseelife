import { z } from 'zod';

/**
 * Academy quiz-authoring HTTP DTOs (TS-254; PRD §9.2–§9.3; PDD §15.1).
 *
 * The admin-facing surface that builds a quiz's **versioned question bank** for
 * a `quiz`-kind lesson. A quiz is the configuration the engine reads to draw,
 * score, and gate: `questionsPerAttempt` (the N-of-M draw), `passingScorePercent`
 * (the certification gate, PRD §9.3), and the retake policy (`maxAttempts` +
 * `retakeCooldownMinutes`). The student-facing attempt surface — which hides the
 * `isCorrect` flags — lives in `academy-quiz-attempt.schema.ts`.
 *
 * **Platform-wide catalog content.** A quiz, its questions, and their options
 * carry no tenant axis — the same bank is presented to every student (the
 * `AcademyQuiz` / `AcademyQuizQuestion` / `AcademyQuizQuestionOption` Prisma
 * models are in service-academy's `unscopedModels`). Only the per-student
 * `AcademyQuizAttempt` rows are tenant-scoped.
 *
 * **Versioned bank.** Every question/option mutation bumps the quiz's
 * `bankVersion`; each attempt records the version it was drawn against, so a
 * later edit never silently rewrites a historical attempt's meaning.
 *
 * **Authorisation.** Every endpoint consuming these DTOs is gated on
 * `academy:read` (the authoring tree read) / `academy:write` (the mutations) via
 * `@RequirePermissions(...)` + `PermissionGuard` (CLAUDE.md §3.2).
 *
 * **`.strict()` everywhere** — a typo in a field name is a 400, not a silently
 * dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────────

/** CUID-shaped id caps. */
export const ACADEMY_QUIZ_ID_MAX_LENGTH = 36;
export const ACADEMY_QUIZ_QUESTION_ID_MAX_LENGTH = 36;
export const ACADEMY_QUIZ_OPTION_ID_MAX_LENGTH = 36;
/** Parent quiz-lesson id cap. */
export const ACADEMY_QUIZ_LESSON_ID_MAX_LENGTH = 36;

export const ACADEMY_QUIZ_TITLE_MAX_LENGTH = 200;
export const ACADEMY_QUIZ_INSTRUCTIONS_MAX_LENGTH = 5_000;
export const ACADEMY_QUIZ_QUESTION_PROMPT_MAX_LENGTH = 2_000;
export const ACADEMY_QUIZ_OPTION_LABEL_MAX_LENGTH = 500;

/** How many questions to draw per attempt (N). Bounded well above any quiz. */
export const ACADEMY_QUIZ_QUESTIONS_PER_ATTEMPT_MAX = 200;
/** Pass threshold bounds (percent). */
export const ACADEMY_QUIZ_PASSING_SCORE_MIN = 0;
export const ACADEMY_QUIZ_PASSING_SCORE_MAX = 100;
/** Total-attempts cap upper bound (the value itself, not the policy). */
export const ACADEMY_QUIZ_MAX_ATTEMPTS_MAX = 100;
/** Retake cooldown upper bound — one year in minutes. */
export const ACADEMY_QUIZ_RETAKE_COOLDOWN_MINUTES_MAX = 525_600;
/** Per-question score weight bounds. */
export const ACADEMY_QUIZ_QUESTION_POINTS_MIN = 1;
export const ACADEMY_QUIZ_QUESTION_POINTS_MAX = 1_000;
/** Options-per-question bounds (a question needs ≥ 2 to be a meaningful choice). */
export const ACADEMY_QUIZ_OPTIONS_PER_QUESTION_MIN = 2;
export const ACADEMY_QUIZ_OPTIONS_PER_QUESTION_MAX = 26;
/** Sort-position upper bound (shared with the catalog convention). */
export const ACADEMY_QUIZ_SORT_POSITION_MAX = 100_000;

// ─── Enum ────────────────────────────────────────────────────────────────────

/**
 * Quiz question type — mirrors the `AcademyQuizQuestionKind` Prisma enum.
 *
 *   `single_choice`   = exactly one correct option; pick one.
 *   `multiple_choice` = one or more correct; the selected set must match the
 *                       correct set exactly (all-or-nothing — no partial credit).
 *   `true_false`      = a `single_choice` with exactly two options.
 *
 * Additive only.
 */
export const AcademyQuizQuestionKindSchema = z.enum([
  'single_choice',
  'multiple_choice',
  'true_false',
]);
export type AcademyQuizQuestionKind = z.infer<typeof AcademyQuizQuestionKindSchema>;

// ─── Field schemas ───────────────────────────────────────────────────────────

const QuizIdSchema = z.string().min(1).max(ACADEMY_QUIZ_ID_MAX_LENGTH);
const QuestionIdSchema = z.string().min(1).max(ACADEMY_QUIZ_QUESTION_ID_MAX_LENGTH);
const OptionIdSchema = z.string().min(1).max(ACADEMY_QUIZ_OPTION_ID_MAX_LENGTH);
const LessonIdSchema = z.string().min(1).max(ACADEMY_QUIZ_LESSON_ID_MAX_LENGTH);
const TitleSchema = z
  .string()
  .trim()
  .min(1, 'a title is required')
  .max(ACADEMY_QUIZ_TITLE_MAX_LENGTH);
const InstructionsSchema = z.string().trim().min(1).max(ACADEMY_QUIZ_INSTRUCTIONS_MAX_LENGTH);
const PromptSchema = z
  .string()
  .trim()
  .min(1, 'a prompt is required')
  .max(ACADEMY_QUIZ_QUESTION_PROMPT_MAX_LENGTH);
const OptionLabelSchema = z
  .string()
  .trim()
  .min(1, 'a label is required')
  .max(ACADEMY_QUIZ_OPTION_LABEL_MAX_LENGTH);
const QuestionsPerAttemptSchema = z
  .number()
  .int()
  .min(1)
  .max(ACADEMY_QUIZ_QUESTIONS_PER_ATTEMPT_MAX);
const PassingScoreSchema = z
  .number()
  .int()
  .min(ACADEMY_QUIZ_PASSING_SCORE_MIN)
  .max(ACADEMY_QUIZ_PASSING_SCORE_MAX);
const MaxAttemptsSchema = z.number().int().min(1).max(ACADEMY_QUIZ_MAX_ATTEMPTS_MAX);
const RetakeCooldownSchema = z.number().int().min(1).max(ACADEMY_QUIZ_RETAKE_COOLDOWN_MINUTES_MAX);
const PointsSchema = z
  .number()
  .int()
  .min(ACADEMY_QUIZ_QUESTION_POINTS_MIN)
  .max(ACADEMY_QUIZ_QUESTION_POINTS_MAX);
const SortPositionSchema = z.number().int().min(0).max(ACADEMY_QUIZ_SORT_POSITION_MAX);
const BankVersionSchema = z.number().int().min(1);
const TimestampSchema = z.string().datetime({ offset: true });

/**
 * Per-kind correctness invariant shared by create + update. `single_choice` and
 * `true_false` require exactly one correct option; `true_false` additionally
 * requires exactly two options; `multiple_choice` requires at least one correct.
 * Validated wherever an option set + kind are both present.
 */
function refineOptionCorrectness(
  kind: AcademyQuizQuestionKind,
  options: ReadonlyArray<{ readonly isCorrect: boolean }>,
  ctx: z.RefinementCtx,
): void {
  const correctCount = options.filter((o) => o.isCorrect).length;
  if (kind === 'true_false' && options.length !== 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: 'a true_false question must have exactly two options',
    });
  }
  if ((kind === 'single_choice' || kind === 'true_false') && correctCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: `a ${kind} question must have exactly one correct option`,
    });
  }
  if (kind === 'multiple_choice' && correctCount < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: 'a multiple_choice question must have at least one correct option',
    });
  }
}

// ─── Record shapes (admin view — carries `isCorrect`) ────────────────────────

/** An answer option as the AUTHOR sees it (the correctness flag is visible). */
export const AcademyQuizQuestionOptionRecordSchema = z
  .object({
    id: OptionIdSchema,
    questionId: QuestionIdSchema,
    label: OptionLabelSchema,
    isCorrect: z.boolean(),
    sortPosition: SortPositionSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AcademyQuizQuestionOptionRecord = z.infer<typeof AcademyQuizQuestionOptionRecordSchema>;

/** A question as the AUTHOR sees it — with its options + correctness flags. */
export const AcademyQuizQuestionRecordSchema = z
  .object({
    id: QuestionIdSchema,
    quizId: QuizIdSchema,
    prompt: PromptSchema,
    kind: AcademyQuizQuestionKindSchema,
    points: PointsSchema,
    sortPosition: SortPositionSchema,
    options: z.array(AcademyQuizQuestionOptionRecordSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AcademyQuizQuestionRecord = z.infer<typeof AcademyQuizQuestionRecordSchema>;

/** The quiz config record (no nested questions — shallow). */
export const AcademyQuizRecordSchema = z
  .object({
    id: QuizIdSchema,
    lessonId: LessonIdSchema,
    title: TitleSchema,
    instructions: InstructionsSchema.nullable(),
    questionsPerAttempt: QuestionsPerAttemptSchema,
    passingScorePercent: PassingScoreSchema,
    maxAttempts: MaxAttemptsSchema.nullable(),
    retakeCooldownMinutes: RetakeCooldownSchema.nullable(),
    shuffleQuestions: z.boolean(),
    bankVersion: BankVersionSchema,
    /** Count of active (non-deleted) questions in the bank. */
    questionCount: z.number().int().min(0),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AcademyQuizRecord = z.infer<typeof AcademyQuizRecordSchema>;

/** The quiz config WITH its full active question bank — the authoring tree. */
export const AcademyQuizAuthoringTreeSchema = AcademyQuizRecordSchema.extend({
  questions: z.array(AcademyQuizQuestionRecordSchema),
}).strict();
export type AcademyQuizAuthoringTree = z.infer<typeof AcademyQuizAuthoringTreeSchema>;

// ─── Quiz create / update ────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/academy/lessons/:lessonId/quiz` body — attach a quiz to a
 * `quiz`-kind lesson (one quiz per lesson; a second is a 409). `shuffleQuestions`
 * defaults to true. The retake-policy fields are optional (omitted = unlimited /
 * no cooldown). The bank is built separately via the question endpoints, so a
 * freshly-created quiz cannot be STARTED until it holds ≥ `questionsPerAttempt`
 * active questions (the service rejects an under-stocked start).
 */
export const CreateAcademyQuizRequestSchema = z
  .object({
    title: TitleSchema,
    instructions: InstructionsSchema.optional(),
    questionsPerAttempt: QuestionsPerAttemptSchema,
    passingScorePercent: PassingScoreSchema,
    maxAttempts: MaxAttemptsSchema.optional(),
    retakeCooldownMinutes: RetakeCooldownSchema.optional(),
    shuffleQuestions: z.boolean().optional(),
  })
  .strict();
export type CreateAcademyQuizRequest = z.infer<typeof CreateAcademyQuizRequestSchema>;

/**
 * `PATCH /api/v1/admin/academy/quizzes/:quizId` body — a partial update of the
 * quiz config. At least one field. Nullable policy fields accept `null` to CLEAR
 * (unlimited attempts / no cooldown).
 */
export const UpdateAcademyQuizRequestSchema = z
  .object({
    title: TitleSchema.optional(),
    instructions: InstructionsSchema.nullable().optional(),
    questionsPerAttempt: QuestionsPerAttemptSchema.optional(),
    passingScorePercent: PassingScoreSchema.optional(),
    maxAttempts: MaxAttemptsSchema.nullable().optional(),
    retakeCooldownMinutes: RetakeCooldownSchema.nullable().optional(),
    shuffleQuestions: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at least one field must be supplied' });
    }
  });
export type UpdateAcademyQuizRequest = z.infer<typeof UpdateAcademyQuizRequestSchema>;

// ─── Question create / update ────────────────────────────────────────────────

/** An option supplied when authoring a question (the id is server-assigned). */
export const AcademyQuizOptionInputSchema = z
  .object({
    label: OptionLabelSchema,
    isCorrect: z.boolean().default(false),
    sortPosition: SortPositionSchema.optional(),
  })
  .strict();
export type AcademyQuizOptionInput = z.infer<typeof AcademyQuizOptionInputSchema>;

/**
 * `POST /api/v1/admin/academy/quizzes/:quizId/questions` body — append a question
 * to the bank with its options inline. `sortPosition` is optional (appended). The
 * per-kind correctness rules are enforced here (exactly-one-correct for
 * single_choice / true_false; two-options for true_false; ≥1-correct for
 * multiple_choice). Mutating the bank bumps the quiz's `bankVersion`.
 */
export const CreateAcademyQuizQuestionRequestSchema = z
  .object({
    prompt: PromptSchema,
    kind: AcademyQuizQuestionKindSchema,
    points: PointsSchema.optional(),
    sortPosition: SortPositionSchema.optional(),
    options: z
      .array(AcademyQuizOptionInputSchema)
      .min(ACADEMY_QUIZ_OPTIONS_PER_QUESTION_MIN)
      .max(ACADEMY_QUIZ_OPTIONS_PER_QUESTION_MAX),
  })
  .strict()
  .superRefine((value, ctx) => {
    refineOptionCorrectness(value.kind, value.options, ctx);
  });
export type CreateAcademyQuizQuestionRequest = z.infer<
  typeof CreateAcademyQuizQuestionRequestSchema
>;

/**
 * `PATCH /api/v1/admin/academy/questions/:questionId` body — a partial update.
 * Supplying `options` REPLACES the question's full option set (the simplest
 * correct model — option ids are not addressable individually). At least one
 * field. When both `kind` and `options` are present the per-kind correctness
 * rule is enforced; when only `options` is present the generic rule applies
 * (≥ 2 options, ≥ 1 correct).
 */
export const UpdateAcademyQuizQuestionRequestSchema = z
  .object({
    prompt: PromptSchema.optional(),
    kind: AcademyQuizQuestionKindSchema.optional(),
    points: PointsSchema.optional(),
    sortPosition: SortPositionSchema.optional(),
    options: z
      .array(AcademyQuizOptionInputSchema)
      .min(ACADEMY_QUIZ_OPTIONS_PER_QUESTION_MIN)
      .max(ACADEMY_QUIZ_OPTIONS_PER_QUESTION_MAX)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at least one field must be supplied' });
    }
    if (value.options !== undefined) {
      if (value.kind !== undefined) {
        refineOptionCorrectness(value.kind, value.options, ctx);
      } else if (value.options.filter((o) => o.isCorrect).length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options'],
          message: 'the option set must have at least one correct option',
        });
      }
    }
  });
export type UpdateAcademyQuizQuestionRequest = z.infer<
  typeof UpdateAcademyQuizQuestionRequestSchema
>;

// ─── Response envelopes ──────────────────────────────────────────────────────

/** Single-quiz envelope returned by create / update. */
export const AcademyQuizResponseSchema = z.object({ quiz: AcademyQuizRecordSchema }).strict();
export type AcademyQuizResponse = z.infer<typeof AcademyQuizResponseSchema>;

/** Authoring-tree envelope returned by the quiz detail read. */
export const AcademyQuizAuthoringResponseSchema = z
  .object({ quiz: AcademyQuizAuthoringTreeSchema })
  .strict();
export type AcademyQuizAuthoringResponse = z.infer<typeof AcademyQuizAuthoringResponseSchema>;

/** Single-question envelope returned by question create / update. */
export const AcademyQuizQuestionResponseSchema = z
  .object({ question: AcademyQuizQuestionRecordSchema })
  .strict();
export type AcademyQuizQuestionResponse = z.infer<typeof AcademyQuizQuestionResponseSchema>;
