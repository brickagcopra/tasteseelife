import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  AcademyQuizAttemptDetail,
  AcademyQuizAttemptRecord,
  AcademyQuizAttemptStatus,
  AcademyQuizQuestionKind,
  GradedQuizAnswer,
  PresentedQuizQuestion,
  QuizAttemptAnswerInput,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';
import { drawQuestions, scoreAttempt, type ScorableQuestion } from './quiz-scoring';
import { evaluateRetakePolicy, type PriorAttemptsSummary } from './quiz-retake-policy';

interface QuizConfigRow {
  readonly id: string;
  readonly questionsPerAttempt: number;
  readonly passingScorePercent: number;
  readonly maxAttempts: number | null;
  readonly retakeCooldownMinutes: number | null;
  readonly shuffleQuestions: boolean;
  readonly bankVersion: number;
}

interface QuestionRow {
  readonly id: string;
  readonly prompt: string;
  readonly kind: AcademyQuizQuestionKind;
  readonly points: number;
  readonly sortPosition: number;
}

interface OptionRow {
  readonly id: string;
  readonly questionId: string;
  readonly label: string;
  readonly isCorrect: boolean;
  readonly sortPosition: number;
}

interface AttemptRow {
  readonly id: string;
  readonly quizId: string;
  readonly studentUserId: string;
  readonly status: AcademyQuizAttemptStatus;
  readonly attemptNumber: number;
  readonly bankVersion: number;
  readonly questionIds: string[];
  readonly pointsAwarded: number | null;
  readonly pointsPossible: number | null;
  readonly scorePercent: number | null;
  readonly passed: boolean | null;
  readonly startedAt: Date;
  readonly submittedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface AnswerRow {
  readonly questionId: string;
  readonly selectedOptionIds: string[];
  readonly correct: boolean;
  readonly pointsAwarded: number;
}

const QUIZ_CONFIG_SELECT = {
  id: true,
  questionsPerAttempt: true,
  passingScorePercent: true,
  maxAttempts: true,
  retakeCooldownMinutes: true,
  shuffleQuestions: true,
  bankVersion: true,
} as const;

const QUESTION_SELECT = {
  id: true,
  prompt: true,
  kind: true,
  points: true,
  sortPosition: true,
} as const;

const OPTION_SELECT = {
  id: true,
  questionId: true,
  label: true,
  isCorrect: true,
  sortPosition: true,
} as const;

const ATTEMPT_SELECT = {
  id: true,
  quizId: true,
  studentUserId: true,
  status: true,
  attemptNumber: true,
  bankVersion: true,
  questionIds: true,
  pointsAwarded: true,
  pointsPossible: true,
  scorePercent: true,
  passed: true,
  startedAt: true,
  submittedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const ANSWER_SELECT = {
  questionId: true,
  selectedOptionIds: true,
  correct: true,
  pointsAwarded: true,
} as const;

export type StartAttemptOutcome =
  | { readonly ok: true; readonly detail: AcademyQuizAttemptDetail }
  | { readonly ok: false; readonly reason: 'quiz_not_found' }
  | { readonly ok: false; readonly reason: 'insufficient_questions' }
  | { readonly ok: false; readonly reason: 'attempt_in_progress' }
  | { readonly ok: false; readonly reason: 'max_attempts_reached' }
  | { readonly ok: false; readonly reason: 'cooldown_active'; readonly retryAfter: Date };

export type SubmitAttemptOutcome =
  | { readonly ok: true; readonly detail: AcademyQuizAttemptDetail }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'already_submitted' }
  | { readonly ok: false; readonly reason: 'invalid_question'; readonly questionId: string };

export type GetAttemptOutcome =
  | { readonly ok: true; readonly detail: AcademyQuizAttemptDetail }
  | { readonly ok: false; readonly reason: 'not_found' };

/**
 * Academy quiz-attempt service (TS-254; PRD §9.2–§9.3; PDD §15.1).
 *
 * The student-facing engine: start (randomized N-of-M draw + retake-policy
 * enforcement), submit (grade + gate on the pass threshold), get / list. Attempt
 * rows are PER-STUDENT (the `AcademyQuizAttempt` model flows through the TS-141
 * gate); every read/write is filtered by the authenticated `studentUserId` —
 * a foreign attempt id resolves to `not_found`, never another student's row.
 *
 * The randomized draw and the scoring math live in the pure `quiz-scoring` /
 * `quiz-retake-policy` modules (exhaustively unit-tested). The clock and RNG are
 * injected (defaulting to the real ones) so the orchestration is deterministic
 * under test.
 */
@Injectable()
export class QuizAttemptService {
  private readonly logger = new Logger(QuizAttemptService.name);

  constructor(
    private readonly prisma: PrismaService,
    // `@Optional()` is load-bearing, not decoration (TS-506). A default
    // parameter value does NOT make Nest skip the parameter: it reads
    // `design:paramtypes`, sees `Function`, and tries to resolve a provider
    // by that token — which no module declares, so the whole service failed
    // to construct and `service-academy` died in the injector before binding
    // a port. With `@Optional()` Nest injects `undefined` and the default
    // applies, which is what this test seam always meant.
    @Optional() private readonly now: () => Date = () => new Date(),
    @Optional() private readonly rng: () => number = Math.random,
  ) {}

  /** Start a new attempt: enforce the retake policy, draw the question set, freeze it. */
  async startAttempt(quizId: string, studentUserId: string): Promise<StartAttemptOutcome> {
    const quiz = (await this.prisma.academyQuiz.findFirst({
      where: { id: quizId },
      select: QUIZ_CONFIG_SELECT,
    })) as QuizConfigRow | null;
    if (quiz === null) return { ok: false, reason: 'quiz_not_found' };

    const pool = (await this.prisma.academyQuizQuestion.findMany({
      where: { quizId, deletedAt: null },
      orderBy: [{ sortPosition: 'asc' }, { id: 'asc' }],
      select: QUESTION_SELECT,
    })) as QuestionRow[];
    if (pool.length < quiz.questionsPerAttempt) {
      return { ok: false, reason: 'insufficient_questions' };
    }

    const decision = evaluateRetakePolicy(
      { maxAttempts: quiz.maxAttempts, retakeCooldownMinutes: quiz.retakeCooldownMinutes },
      await this.summarisePriorAttempts(quizId, studentUserId),
      this.now(),
    );
    if (!decision.ok) {
      return decision.reason === 'cooldown_active'
        ? { ok: false, reason: 'cooldown_active', retryAfter: decision.retryAfter }
        : { ok: false, reason: decision.reason };
    }

    let drawn = drawQuestions(pool, quiz.questionsPerAttempt, this.rng);
    if (!quiz.shuffleQuestions) {
      // The draw is always a random N-of-M; when shuffle is off we present the
      // drawn set in stable authoring order rather than draw order.
      drawn = [...drawn].sort(
        (a, b) => a.sortPosition - b.sortPosition || a.id.localeCompare(b.id),
      );
    }

    const created = (await this.prisma.academyQuizAttempt.create({
      data: {
        quizId,
        studentUserId,
        status: 'in_progress',
        attemptNumber: decision.attemptNumber,
        bankVersion: quiz.bankVersion,
        questionIds: drawn.map((q) => q.id),
      },
      select: ATTEMPT_SELECT,
    })) as AttemptRow;

    const presented = await this.presentQuestions(drawn);
    this.logger.log(
      { quizId, attemptId: created.id, studentUserId, attemptNumber: created.attemptNumber },
      'academy quiz attempt started',
    );
    return {
      ok: true,
      detail: { attempt: toAttemptRecord(created), questions: presented, answers: [] },
    };
  }

  /** Submit answers, grade the attempt, and gate on the pass threshold. */
  async submitAttempt(
    attemptId: string,
    studentUserId: string,
    answers: readonly QuizAttemptAnswerInput[],
  ): Promise<SubmitAttemptOutcome> {
    const attempt = (await this.prisma.academyQuizAttempt.findFirst({
      where: { id: attemptId, studentUserId },
      select: ATTEMPT_SELECT,
    })) as AttemptRow | null;
    if (attempt === null) return { ok: false, reason: 'not_found' };
    if (attempt.status !== 'in_progress') return { ok: false, reason: 'already_submitted' };

    const drawnIds = new Set(attempt.questionIds);
    for (const answer of answers) {
      if (!drawnIds.has(answer.questionId)) {
        return { ok: false, reason: 'invalid_question', questionId: answer.questionId };
      }
    }

    const { questions, optionsByQuestion } = await this.loadDrawnQuestions(attempt.questionIds);
    const scorable: ScorableQuestion[] = questions.map((q) => ({
      id: q.id,
      kind: q.kind,
      points: q.points,
      options: (optionsByQuestion.get(q.id) ?? []).map((o) => ({
        id: o.id,
        isCorrect: o.isCorrect,
      })),
    }));

    const answersByQuestion = new Map<string, readonly string[]>(
      answers.map((a) => [a.questionId, a.selectedOptionIds]),
    );
    const scored = scoreAttempt(
      scorable,
      answersByQuestion,
      await this.passingScore(attempt.quizId),
    );

    // Persist the graded answers, then transition the attempt. The integration
    // test (TS-254-followup) covers the FK + transactional behaviour against a
    // real Postgres; the in_progress→submitted guard above makes a retried
    // submit a no-op (it resolves `already_submitted`).
    for (const g of scored.graded) {
      await this.prisma.academyQuizAttemptAnswer.create({
        data: {
          attemptId,
          questionId: g.questionId,
          selectedOptionIds: [...g.selectedOptionIds],
          correct: g.correct,
          pointsAwarded: g.pointsAwarded,
        },
        select: { id: true },
      });
    }

    const updated = (await this.prisma.academyQuizAttempt.update({
      where: { id: attemptId },
      data: {
        status: 'submitted',
        pointsAwarded: scored.pointsAwarded,
        pointsPossible: scored.pointsPossible,
        scorePercent: scored.scorePercent,
        passed: scored.passed,
        submittedAt: this.now(),
      },
      select: ATTEMPT_SELECT,
    })) as AttemptRow;

    const presented = await this.presentQuestions(questions, optionsByQuestion);
    const graded: GradedQuizAnswer[] = scored.graded.map((g) => {
      const q = questions.find((x) => x.id === g.questionId);
      return {
        questionId: g.questionId,
        prompt: q?.prompt ?? '',
        kind: q?.kind ?? 'single_choice',
        selectedOptionIds: [...g.selectedOptionIds],
        correctOptionIds: [...g.correctOptionIds],
        correct: g.correct,
        pointsAwarded: g.pointsAwarded,
        pointsPossible: g.pointsPossible,
      };
    });

    this.logger.log(
      {
        attemptId,
        quizId: attempt.quizId,
        studentUserId,
        scorePercent: scored.scorePercent,
        passed: scored.passed,
      },
      'academy quiz attempt submitted',
    );
    return {
      ok: true,
      detail: { attempt: toAttemptRecord(updated), questions: presented, answers: graded },
    };
  }

  /** Read one of the student's own attempts (graded answers revealed post-submit). */
  async getAttempt(attemptId: string, studentUserId: string): Promise<GetAttemptOutcome> {
    const attempt = (await this.prisma.academyQuizAttempt.findFirst({
      where: { id: attemptId, studentUserId },
      select: ATTEMPT_SELECT,
    })) as AttemptRow | null;
    if (attempt === null) return { ok: false, reason: 'not_found' };

    const { questions, optionsByQuestion } = await this.loadDrawnQuestions(attempt.questionIds);
    const presented = await this.presentQuestions(questions, optionsByQuestion);

    let graded: GradedQuizAnswer[] = [];
    if (attempt.status === 'submitted') {
      const answerRows = (await this.prisma.academyQuizAttemptAnswer.findMany({
        where: { attemptId },
        select: ANSWER_SELECT,
      })) as AnswerRow[];
      graded = answerRows.map((row) => {
        const q = questions.find((x) => x.id === row.questionId);
        const correctOptionIds = (optionsByQuestion.get(row.questionId) ?? [])
          .filter((o) => o.isCorrect)
          .map((o) => o.id);
        return {
          questionId: row.questionId,
          prompt: q?.prompt ?? '',
          kind: q?.kind ?? 'single_choice',
          selectedOptionIds: [...row.selectedOptionIds],
          correctOptionIds,
          correct: row.correct,
          pointsAwarded: row.pointsAwarded,
          pointsPossible: q?.points ?? 0,
        };
      });
    }

    return {
      ok: true,
      detail: { attempt: toAttemptRecord(attempt), questions: presented, answers: graded },
    };
  }

  /** The student's own attempts at a quiz, newest first. */
  async listAttempts(
    quizId: string,
    studentUserId: string,
  ): Promise<readonly AcademyQuizAttemptRecord[]> {
    const rows = (await this.prisma.academyQuizAttempt.findMany({
      where: { quizId, studentUserId },
      orderBy: [{ attemptNumber: 'desc' }, { id: 'desc' }],
      select: ATTEMPT_SELECT,
    })) as AttemptRow[];
    return rows.map(toAttemptRecord);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async summarisePriorAttempts(
    quizId: string,
    studentUserId: string,
  ): Promise<PriorAttemptsSummary> {
    const totalCount = await this.prisma.academyQuizAttempt.count({
      where: { quizId, studentUserId },
    });
    const inProgress = (await this.prisma.academyQuizAttempt.findFirst({
      where: { quizId, studentUserId, status: 'in_progress' },
      select: { id: true },
    })) as { id: string } | null;
    const lastSubmitted = (await this.prisma.academyQuizAttempt.findFirst({
      where: { quizId, studentUserId, status: 'submitted' },
      orderBy: { submittedAt: 'desc' },
      select: { submittedAt: true },
    })) as { submittedAt: Date | null } | null;

    return {
      totalCount,
      hasInProgress: inProgress !== null,
      lastSubmittedAt: lastSubmitted?.submittedAt ?? null,
    };
  }

  private async passingScore(quizId: string): Promise<number> {
    const quiz = (await this.prisma.academyQuiz.findFirst({
      where: { id: quizId },
      select: { passingScorePercent: true },
    })) as { passingScorePercent: number } | null;
    return quiz?.passingScorePercent ?? 100;
  }

  private async loadDrawnQuestions(
    questionIds: readonly string[],
  ): Promise<{ questions: QuestionRow[]; optionsByQuestion: Map<string, OptionRow[]> }> {
    if (questionIds.length === 0) return { questions: [], optionsByQuestion: new Map() };

    const rows = (await this.prisma.academyQuizQuestion.findMany({
      where: { id: { in: [...questionIds] } },
      select: QUESTION_SELECT,
    })) as QuestionRow[];
    // Preserve the attempt's frozen presentation order.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const questions = questionIds
      .map((id) => byId.get(id))
      .filter((r): r is QuestionRow => r !== undefined);

    const options = (await this.prisma.academyQuizQuestionOption.findMany({
      where: { questionId: { in: questions.map((q) => q.id) } },
      orderBy: [{ sortPosition: 'asc' }, { id: 'asc' }],
      select: OPTION_SELECT,
    })) as OptionRow[];
    const optionsByQuestion = new Map<string, OptionRow[]>();
    for (const option of options) {
      const bucket = optionsByQuestion.get(option.questionId);
      if (bucket === undefined) optionsByQuestion.set(option.questionId, [option]);
      else bucket.push(option);
    }
    return { questions, optionsByQuestion };
  }

  private async presentQuestions(
    questions: readonly QuestionRow[],
    preloaded?: Map<string, OptionRow[]>,
  ): Promise<PresentedQuizQuestion[]> {
    const optionsByQuestion =
      preloaded ?? (await this.loadDrawnQuestions(questions.map((q) => q.id))).optionsByQuestion;
    return questions.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      kind: q.kind,
      points: q.points,
      options: (optionsByQuestion.get(q.id) ?? []).map((o) => ({
        id: o.id,
        label: o.label,
        sortPosition: o.sortPosition,
      })),
    }));
  }
}

/** Project an attempt row into the wire `AcademyQuizAttemptRecord`. */
export function toAttemptRecord(row: AttemptRow): AcademyQuizAttemptRecord {
  return {
    id: row.id,
    quizId: row.quizId,
    studentUserId: row.studentUserId,
    status: row.status,
    attemptNumber: row.attemptNumber,
    bankVersion: row.bankVersion,
    questionIds: [...row.questionIds],
    pointsAwarded: row.pointsAwarded,
    pointsPossible: row.pointsPossible,
    scorePercent: row.scorePercent,
    passed: row.passed,
    startedAt: row.startedAt.toISOString(),
    submittedAt: row.submittedAt === null ? null : row.submittedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
