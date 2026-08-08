import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type {
  AcademyQuizAuthoringTree,
  AcademyQuizQuestionRecord,
  AcademyQuizRecord,
} from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import {
  QuizAuthoringService,
  type CreateQuestionOutcome,
  type CreateQuizOutcome,
  type DeleteQuestionOutcome,
  type DeleteQuizOutcome,
  type GetQuizTreeOutcome,
  type UpdateQuestionOutcome,
  type UpdateQuizOutcome,
} from '../services/quiz-authoring.service';
import { QuizAdminController } from './quiz-admin.controller';

const TS = '2026-06-01T00:00:00.000Z';

function quizRecord(overrides: Partial<AcademyQuizRecord> = {}): AcademyQuizRecord {
  return {
    id: 'quiz_1',
    lessonId: 'lesson_1',
    title: 'Knife safety',
    instructions: null,
    questionsPerAttempt: 2,
    passingScorePercent: 70,
    maxAttempts: null,
    retakeCooldownMinutes: null,
    shuffleQuestions: true,
    bankVersion: 1,
    questionCount: 0,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function questionRecord(
  overrides: Partial<AcademyQuizQuestionRecord> = {},
): AcademyQuizQuestionRecord {
  return {
    id: 'question_1',
    quizId: 'quiz_1',
    prompt: 'Safest grip?',
    kind: 'single_choice',
    points: 1,
    sortPosition: 0,
    options: [
      {
        id: 'o1',
        questionId: 'question_1',
        label: 'Claw',
        isCorrect: true,
        sortPosition: 0,
        createdAt: TS,
        updatedAt: TS,
      },
      {
        id: 'o2',
        questionId: 'question_1',
        label: 'Loose',
        isCorrect: false,
        sortPosition: 1,
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

const tree: AcademyQuizAuthoringTree = {
  ...quizRecord({ questionCount: 1 }),
  questions: [questionRecord()],
};

interface FakeService {
  createQuiz: ReturnType<typeof vi.fn>;
  getAuthoringTree: ReturnType<typeof vi.fn>;
  updateQuiz: ReturnType<typeof vi.fn>;
  deleteQuiz: ReturnType<typeof vi.fn>;
  createQuestion: ReturnType<typeof vi.fn>;
  updateQuestion: ReturnType<typeof vi.fn>;
  softDeleteQuestion: ReturnType<typeof vi.fn>;
}

function build(overrides: Partial<FakeService> = {}): {
  controller: QuizAdminController;
  service: FakeService;
} {
  const service: FakeService = {
    createQuiz: vi.fn(async (): Promise<CreateQuizOutcome> => ({ ok: true, quiz: quizRecord() })),
    getAuthoringTree: vi.fn(async (): Promise<GetQuizTreeOutcome> => ({ ok: true, quiz: tree })),
    updateQuiz: vi.fn(
      async (): Promise<UpdateQuizOutcome> => ({
        ok: true,
        quiz: quizRecord({ passingScorePercent: 90 }),
      }),
    ),
    deleteQuiz: vi.fn(async (): Promise<DeleteQuizOutcome> => ({ ok: true })),
    createQuestion: vi.fn(
      async (): Promise<CreateQuestionOutcome> => ({ ok: true, question: questionRecord() }),
    ),
    updateQuestion: vi.fn(
      async (): Promise<UpdateQuestionOutcome> => ({ ok: true, question: questionRecord() }),
    ),
    softDeleteQuestion: vi.fn(async (): Promise<DeleteQuestionOutcome> => ({ ok: true })),
    ...overrides,
  };
  const controller = new QuizAdminController(service as unknown as QuizAuthoringService);
  return { controller, service };
}

function adminRequest(userId = 'admin_1'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

const createBody = { title: 'Knife safety', questionsPerAttempt: 2, passingScorePercent: 70 };
const questionBody = {
  prompt: 'Safest grip?',
  kind: 'single_choice' as const,
  options: [
    { label: 'Claw', isCorrect: true },
    { label: 'Loose', isCorrect: false },
  ],
};

describe('QuizAdminController.createQuiz', () => {
  it('creates and attributes the actor', async () => {
    const { controller, service } = build();
    const res = await controller.createQuiz('lesson_1', createBody, adminRequest('u9'));
    expect(res.quiz.id).toBe('quiz_1');
    expect(service.createQuiz).toHaveBeenCalledWith(
      expect.objectContaining({ lessonId: 'lesson_1', actorUserId: 'u9' }),
    );
  });

  it('401s without a context', async () => {
    const { controller } = build();
    await expect(
      controller.createQuiz('lesson_1', createBody, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('404s when the lesson is missing', async () => {
    const { controller } = build({
      createQuiz: vi.fn(
        async (): Promise<CreateQuizOutcome> => ({ ok: false, reason: 'lesson_not_found' }),
      ),
    });
    await expect(controller.createQuiz('nope', createBody, adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('409s when the lesson is not a quiz lesson', async () => {
    const { controller } = build({
      createQuiz: vi.fn(
        async (): Promise<CreateQuizOutcome> => ({ ok: false, reason: 'lesson_not_quiz' }),
      ),
    });
    await expect(
      controller.createQuiz('lesson_v', createBody, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('409s when a quiz already exists', async () => {
    const { controller } = build({
      createQuiz: vi.fn(
        async (): Promise<CreateQuizOutcome> => ({ ok: false, reason: 'quiz_exists' }),
      ),
    });
    await expect(
      controller.createQuiz('lesson_1', createBody, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('QuizAdminController.getQuiz', () => {
  it('returns the authoring tree', async () => {
    const { controller } = build();
    const res = await controller.getQuiz('lesson_1');
    expect(res.quiz.questions).toHaveLength(1);
  });

  it('404s when the lesson has no quiz', async () => {
    const { controller } = build({
      getAuthoringTree: vi.fn(
        async (): Promise<GetQuizTreeOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.getQuiz('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('QuizAdminController.updateQuiz / removeQuiz', () => {
  it('updates the quiz config', async () => {
    const { controller } = build();
    expect(
      (await controller.updateQuiz('quiz_1', { passingScorePercent: 90 }, adminRequest())).quiz
        .passingScorePercent,
    ).toBe(90);
  });

  it('404s updating a missing quiz', async () => {
    const { controller } = build({
      updateQuiz: vi.fn(
        async (): Promise<UpdateQuizOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(
      controller.updateQuiz('nope', { title: 'x' }, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('204s on delete', async () => {
    const { controller } = build();
    await expect(controller.removeQuiz('quiz_1', adminRequest())).resolves.toBeUndefined();
  });

  it('404s deleting a missing quiz', async () => {
    const { controller } = build({
      deleteQuiz: vi.fn(
        async (): Promise<DeleteQuizOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.removeQuiz('nope', adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('409s deleting a quiz with attempts', async () => {
    const { controller } = build({
      deleteQuiz: vi.fn(
        async (): Promise<DeleteQuizOutcome> => ({ ok: false, reason: 'has_attempts' }),
      ),
    });
    await expect(controller.removeQuiz('quiz_1', adminRequest())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('QuizAdminController questions', () => {
  it('creates a question', async () => {
    const { controller, service } = build();
    const res = await controller.createQuestion('quiz_1', questionBody, adminRequest('u3'));
    expect(res.question.id).toBe('question_1');
    expect(service.createQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ quizId: 'quiz_1', actorUserId: 'u3' }),
    );
  });

  it('404s creating a question on a missing quiz', async () => {
    const { controller } = build({
      createQuestion: vi.fn(
        async (): Promise<CreateQuestionOutcome> => ({ ok: false, reason: 'quiz_not_found' }),
      ),
    });
    await expect(
      controller.createQuestion('nope', questionBody, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates a question', async () => {
    const { controller } = build();
    expect(
      (await controller.updateQuestion('question_1', { prompt: 'New?' }, adminRequest())).question
        .id,
    ).toBe('question_1');
  });

  it('404s updating a missing question', async () => {
    const { controller } = build({
      updateQuestion: vi.fn(
        async (): Promise<UpdateQuestionOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(
      controller.updateQuestion('nope', { prompt: 'x' }, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('204s on question delete', async () => {
    const { controller } = build();
    await expect(controller.removeQuestion('question_1', adminRequest())).resolves.toBeUndefined();
  });

  it('404s deleting a missing question', async () => {
    const { controller } = build({
      softDeleteQuestion: vi.fn(
        async (): Promise<DeleteQuestionOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.removeQuestion('nope', adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
