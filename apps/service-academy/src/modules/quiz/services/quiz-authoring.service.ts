import { Injectable, Logger } from '@nestjs/common';
import type {
  AcademyQuizAuthoringTree,
  AcademyQuizOptionInput,
  AcademyQuizQuestionKind,
  AcademyQuizQuestionOptionRecord,
  AcademyQuizQuestionRecord,
  AcademyQuizRecord,
  CreateAcademyQuizQuestionRequest,
  CreateAcademyQuizRequest,
  UpdateAcademyQuizQuestionRequest,
  UpdateAcademyQuizRequest,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/** Local mirrors of the Prisma rows (TS-021-followup-3 convention). */
export interface AcademyQuizRow {
  readonly id: string;
  readonly lessonId: string;
  readonly title: string;
  readonly instructions: string | null;
  readonly questionsPerAttempt: number;
  readonly passingScorePercent: number;
  readonly maxAttempts: number | null;
  readonly retakeCooldownMinutes: number | null;
  readonly shuffleQuestions: boolean;
  readonly bankVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AcademyQuizQuestionRow {
  readonly id: string;
  readonly quizId: string;
  readonly prompt: string;
  readonly kind: AcademyQuizQuestionKind;
  readonly points: number;
  readonly sortPosition: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface AcademyQuizOptionRow {
  readonly id: string;
  readonly questionId: string;
  readonly label: string;
  readonly isCorrect: boolean;
  readonly sortPosition: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Explicit column projections — never `SELECT *` (CLAUDE.md §4.1). */
const QUIZ_SELECT = {
  id: true,
  lessonId: true,
  title: true,
  instructions: true,
  questionsPerAttempt: true,
  passingScorePercent: true,
  maxAttempts: true,
  retakeCooldownMinutes: true,
  shuffleQuestions: true,
  bankVersion: true,
  createdAt: true,
  updatedAt: true,
} as const;

const QUESTION_SELECT = {
  id: true,
  quizId: true,
  prompt: true,
  kind: true,
  points: true,
  sortPosition: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

const OPTION_SELECT = {
  id: true,
  questionId: true,
  label: true,
  isCorrect: true,
  sortPosition: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface CreateQuizInput extends CreateAcademyQuizRequest {
  readonly lessonId: string;
  readonly actorUserId: string;
}

export interface UpdateQuizInput extends UpdateAcademyQuizRequest {
  readonly quizId: string;
  readonly actorUserId: string;
}

export interface CreateQuestionInput extends CreateAcademyQuizQuestionRequest {
  readonly quizId: string;
  readonly actorUserId: string;
}

export interface UpdateQuestionInput extends UpdateAcademyQuizQuestionRequest {
  readonly questionId: string;
  readonly actorUserId: string;
}

export type CreateQuizOutcome =
  | { readonly ok: true; readonly quiz: AcademyQuizRecord }
  | { readonly ok: false; readonly reason: 'lesson_not_found' }
  | { readonly ok: false; readonly reason: 'lesson_not_quiz' }
  | { readonly ok: false; readonly reason: 'quiz_exists' };

export type GetQuizTreeOutcome =
  | { readonly ok: true; readonly quiz: AcademyQuizAuthoringTree }
  | { readonly ok: false; readonly reason: 'not_found' };

export type UpdateQuizOutcome =
  | { readonly ok: true; readonly quiz: AcademyQuizRecord }
  | { readonly ok: false; readonly reason: 'not_found' };

export type DeleteQuizOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'has_attempts' };

export type CreateQuestionOutcome =
  | { readonly ok: true; readonly question: AcademyQuizQuestionRecord }
  | { readonly ok: false; readonly reason: 'quiz_not_found' };

export type UpdateQuestionOutcome =
  | { readonly ok: true; readonly question: AcademyQuizQuestionRecord }
  | { readonly ok: false; readonly reason: 'not_found' };

export type DeleteQuestionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_found' };

/**
 * Academy quiz-authoring service (TS-254; PRD §9.2–§9.3; PDD §15.1).
 *
 * Owns the versioned question bank for a `quiz`-kind lesson: create / read-tree
 * / edit / delete a quiz; append / edit / soft-delete questions (with their
 * options inline). The bank is platform-wide CATALOG content (no tenant axis;
 * `unscopedModels`) so reads + writes do not consult the TS-141 gate.
 *
 * Every question/option mutation bumps the quiz's `bankVersion` so a later edit
 * never silently rewrites a historical attempt's meaning (the attempt freezes
 * the version it drew against — the "versioned bank" requirement).
 *
 * Authorisation (`academy:read` / `academy:write`) is enforced at the controller
 * boundary; the service trusts the actor id it is handed.
 */
@Injectable()
export class QuizAuthoringService {
  private readonly logger = new Logger(QuizAuthoringService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Attach a quiz to a `quiz`-kind lesson (one quiz per lesson). */
  async createQuiz(input: CreateQuizInput): Promise<CreateQuizOutcome> {
    const lesson = (await this.prisma.academyLesson.findFirst({
      where: { id: input.lessonId },
      select: { id: true, kind: true },
    })) as { id: string; kind: string } | null;
    if (lesson === null) return { ok: false, reason: 'lesson_not_found' };
    if (lesson.kind !== 'quiz') return { ok: false, reason: 'lesson_not_quiz' };

    const existing = (await this.prisma.academyQuiz.findFirst({
      where: { lessonId: input.lessonId },
      select: { id: true },
    })) as { id: string } | null;
    if (existing !== null) return { ok: false, reason: 'quiz_exists' };

    const created = (await this.prisma.academyQuiz.create({
      data: {
        lessonId: input.lessonId,
        title: input.title,
        instructions: input.instructions ?? null,
        questionsPerAttempt: input.questionsPerAttempt,
        passingScorePercent: input.passingScorePercent,
        maxAttempts: input.maxAttempts ?? null,
        retakeCooldownMinutes: input.retakeCooldownMinutes ?? null,
        shuffleQuestions: input.shuffleQuestions ?? true,
      },
      select: QUIZ_SELECT,
    })) as AcademyQuizRow;

    this.logger.log(
      { quizId: created.id, lessonId: input.lessonId, actorUserId: input.actorUserId },
      'academy quiz created',
    );
    return { ok: true, quiz: toQuizRecord(created, 0) };
  }

  /** The quiz + its active question bank (options nested), by lesson id. */
  async getAuthoringTree(lessonId: string): Promise<GetQuizTreeOutcome> {
    const quiz = (await this.prisma.academyQuiz.findFirst({
      where: { lessonId },
      select: QUIZ_SELECT,
    })) as AcademyQuizRow | null;
    if (quiz === null) return { ok: false, reason: 'not_found' };

    const questions = await this.loadActiveQuestions(quiz.id);
    const tree: AcademyQuizAuthoringTree = {
      ...toQuizRecord(quiz, questions.length),
      questions,
    };
    return { ok: true, quiz: tree };
  }

  /** Partial update of the quiz config. */
  async updateQuiz(input: UpdateQuizInput): Promise<UpdateQuizOutcome> {
    const current = (await this.prisma.academyQuiz.findFirst({
      where: { id: input.quizId },
      select: { id: true },
    })) as { id: string } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data['title'] = input.title;
    if (input.instructions !== undefined) data['instructions'] = input.instructions;
    if (input.questionsPerAttempt !== undefined)
      data['questionsPerAttempt'] = input.questionsPerAttempt;
    if (input.passingScorePercent !== undefined)
      data['passingScorePercent'] = input.passingScorePercent;
    if (input.maxAttempts !== undefined) data['maxAttempts'] = input.maxAttempts;
    if (input.retakeCooldownMinutes !== undefined)
      data['retakeCooldownMinutes'] = input.retakeCooldownMinutes;
    if (input.shuffleQuestions !== undefined) data['shuffleQuestions'] = input.shuffleQuestions;

    const updated = (await this.prisma.academyQuiz.update({
      where: { id: input.quizId },
      data,
      select: QUIZ_SELECT,
    })) as AcademyQuizRow;

    const questionCount = await this.prisma.academyQuizQuestion.count({
      where: { quizId: input.quizId, deletedAt: null },
    });

    this.logger.log(
      { quizId: input.quizId, actorUserId: input.actorUserId, fields: Object.keys(data) },
      'academy quiz updated',
    );
    return { ok: true, quiz: toQuizRecord(updated, questionCount) };
  }

  /** Hard-delete a quiz (cascades questions + options). Rejected when attempts exist. */
  async deleteQuiz(quizId: string, actorUserId: string): Promise<DeleteQuizOutcome> {
    const current = (await this.prisma.academyQuiz.findFirst({
      where: { id: quizId },
      select: { id: true },
    })) as { id: string } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    const attemptCount = await this.prisma.academyQuizAttempt.count({ where: { quizId } });
    if (attemptCount > 0) return { ok: false, reason: 'has_attempts' };

    await this.prisma.academyQuiz.delete({ where: { id: quizId } });

    this.logger.log({ quizId, actorUserId }, 'academy quiz deleted');
    return { ok: true };
  }

  /** Append a question (with options) to the bank; bumps `bankVersion`. */
  async createQuestion(input: CreateQuestionInput): Promise<CreateQuestionOutcome> {
    const quiz = (await this.prisma.academyQuiz.findFirst({
      where: { id: input.quizId },
      select: { id: true },
    })) as { id: string } | null;
    if (quiz === null) return { ok: false, reason: 'quiz_not_found' };

    const sortPosition = input.sortPosition ?? (await this.nextQuestionSortPosition(input.quizId));

    const created = (await this.prisma.academyQuizQuestion.create({
      data: {
        quizId: input.quizId,
        prompt: input.prompt,
        kind: input.kind,
        points: input.points ?? 1,
        sortPosition,
      },
      select: QUESTION_SELECT,
    })) as AcademyQuizQuestionRow;

    await this.createOptions(created.id, input.options);
    await this.bumpBankVersion(input.quizId);

    const options = await this.loadOptions(created.id);
    this.logger.log(
      { quizId: input.quizId, questionId: created.id, actorUserId: input.actorUserId },
      'academy quiz question created',
    );
    return { ok: true, question: toQuestionRecord(created, options) };
  }

  /** Partial update of a question; replaces options when supplied. Bumps `bankVersion`. */
  async updateQuestion(input: UpdateQuestionInput): Promise<UpdateQuestionOutcome> {
    const current = (await this.prisma.academyQuizQuestion.findFirst({
      where: { id: input.questionId, deletedAt: null },
      select: { id: true, quizId: true },
    })) as { id: string; quizId: string } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    const data: Record<string, unknown> = {};
    if (input.prompt !== undefined) data['prompt'] = input.prompt;
    if (input.kind !== undefined) data['kind'] = input.kind;
    if (input.points !== undefined) data['points'] = input.points;
    if (input.sortPosition !== undefined) data['sortPosition'] = input.sortPosition;

    const updated = (await this.prisma.academyQuizQuestion.update({
      where: { id: input.questionId },
      data,
      select: QUESTION_SELECT,
    })) as AcademyQuizQuestionRow;

    if (input.options !== undefined) {
      await this.prisma.academyQuizQuestionOption.deleteMany({
        where: { questionId: input.questionId },
      });
      await this.createOptions(input.questionId, input.options);
    }

    await this.bumpBankVersion(current.quizId);

    const options = await this.loadOptions(input.questionId);
    this.logger.log(
      {
        questionId: input.questionId,
        quizId: current.quizId,
        actorUserId: input.actorUserId,
        fields: Object.keys(data),
        optionsReplaced: input.options !== undefined,
      },
      'academy quiz question updated',
    );
    return { ok: true, question: toQuestionRecord(updated, options) };
  }

  /** Soft-delete a question (remove from the draw pool); bumps `bankVersion`. */
  async softDeleteQuestion(
    questionId: string,
    actorUserId: string,
  ): Promise<DeleteQuestionOutcome> {
    const current = (await this.prisma.academyQuizQuestion.findFirst({
      where: { id: questionId, deletedAt: null },
      select: { id: true, quizId: true },
    })) as { id: string; quizId: string } | null;
    if (current === null) return { ok: false, reason: 'not_found' };

    await this.prisma.academyQuizQuestion.update({
      where: { id: questionId },
      data: { deletedAt: new Date() },
      select: { id: true },
    });
    await this.bumpBankVersion(current.quizId);

    this.logger.log(
      { questionId, quizId: current.quizId, actorUserId },
      'academy quiz question soft-deleted',
    );
    return { ok: true };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async createOptions(
    questionId: string,
    options: readonly AcademyQuizOptionInput[],
  ): Promise<void> {
    let index = 0;
    for (const option of options) {
      await this.prisma.academyQuizQuestionOption.create({
        data: {
          questionId,
          label: option.label,
          isCorrect: option.isCorrect,
          sortPosition: option.sortPosition ?? index,
        },
        select: { id: true },
      });
      index += 1;
    }
  }

  private async loadOptions(questionId: string): Promise<AcademyQuizQuestionOptionRecord[]> {
    const rows = (await this.prisma.academyQuizQuestionOption.findMany({
      where: { questionId },
      orderBy: [{ sortPosition: 'asc' }, { id: 'asc' }],
      select: OPTION_SELECT,
    })) as AcademyQuizOptionRow[];
    return rows.map(toOptionRecord);
  }

  private async loadActiveQuestions(quizId: string): Promise<AcademyQuizQuestionRecord[]> {
    const questions = (await this.prisma.academyQuizQuestion.findMany({
      where: { quizId, deletedAt: null },
      orderBy: [{ sortPosition: 'asc' }, { id: 'asc' }],
      select: QUESTION_SELECT,
    })) as AcademyQuizQuestionRow[];

    const result: AcademyQuizQuestionRecord[] = [];
    for (const question of questions) {
      const options = await this.loadOptions(question.id);
      result.push(toQuestionRecord(question, options));
    }
    return result;
  }

  private async nextQuestionSortPosition(quizId: string): Promise<number> {
    const last = (await this.prisma.academyQuizQuestion.findFirst({
      where: { quizId },
      orderBy: { sortPosition: 'desc' },
      select: { sortPosition: true },
    })) as { sortPosition: number } | null;
    return last === null ? 0 : last.sortPosition + 1;
  }

  private async bumpBankVersion(quizId: string): Promise<void> {
    await this.prisma.academyQuiz.update({
      where: { id: quizId },
      data: { bankVersion: { increment: 1 } },
      select: { id: true },
    });
  }
}

/** Project a quiz row + live question count into the wire `AcademyQuizRecord`. */
export function toQuizRecord(row: AcademyQuizRow, questionCount: number): AcademyQuizRecord {
  return {
    id: row.id,
    lessonId: row.lessonId,
    title: row.title,
    instructions: row.instructions,
    questionsPerAttempt: row.questionsPerAttempt,
    passingScorePercent: row.passingScorePercent,
    maxAttempts: row.maxAttempts,
    retakeCooldownMinutes: row.retakeCooldownMinutes,
    shuffleQuestions: row.shuffleQuestions,
    bankVersion: row.bankVersion,
    questionCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project a question row + its options into the admin `AcademyQuizQuestionRecord`. */
export function toQuestionRecord(
  row: AcademyQuizQuestionRow,
  options: readonly AcademyQuizQuestionOptionRecord[],
): AcademyQuizQuestionRecord {
  return {
    id: row.id,
    quizId: row.quizId,
    prompt: row.prompt,
    kind: row.kind,
    points: row.points,
    sortPosition: row.sortPosition,
    options: [...options],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project an option row into the admin `AcademyQuizQuestionOptionRecord`. */
export function toOptionRecord(row: AcademyQuizOptionRow): AcademyQuizQuestionOptionRecord {
  return {
    id: row.id,
    questionId: row.questionId,
    label: row.label,
    isCorrect: row.isCorrect,
    sortPosition: row.sortPosition,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
