import {
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { AcademyQuizAttemptDetail, AcademyQuizAttemptRecord } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import {
  QuizAttemptService,
  type GetAttemptOutcome,
  type StartAttemptOutcome,
  type SubmitAttemptOutcome,
} from '../services/quiz-attempt.service';
import { QuizAttemptController } from './quiz-attempt.controller';

const TS = '2026-06-08T12:00:00.000Z';

function attemptRecord(
  overrides: Partial<AcademyQuizAttemptRecord> = {},
): AcademyQuizAttemptRecord {
  return {
    id: 'attempt_1',
    quizId: 'quiz_1',
    studentUserId: 'student_1',
    status: 'in_progress',
    attemptNumber: 1,
    bankVersion: 1,
    questionIds: ['q1', 'q2'],
    pointsAwarded: null,
    pointsPossible: null,
    scorePercent: null,
    passed: null,
    startedAt: TS,
    submittedAt: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

const detail: AcademyQuizAttemptDetail = {
  attempt: attemptRecord(),
  questions: [
    {
      id: 'q1',
      prompt: 'Q1?',
      kind: 'single_choice',
      points: 1,
      options: [{ id: 'q1o1', label: 'a', sortPosition: 0 }],
    },
  ],
  answers: [],
};

interface FakeService {
  startAttempt: ReturnType<typeof vi.fn>;
  submitAttempt: ReturnType<typeof vi.fn>;
  getAttempt: ReturnType<typeof vi.fn>;
  listAttempts: ReturnType<typeof vi.fn>;
}

function build(overrides: Partial<FakeService> = {}): {
  controller: QuizAttemptController;
  service: FakeService;
} {
  const service: FakeService = {
    startAttempt: vi.fn(async (): Promise<StartAttemptOutcome> => ({ ok: true, detail })),
    submitAttempt: vi.fn(async (): Promise<SubmitAttemptOutcome> => ({ ok: true, detail })),
    getAttempt: vi.fn(async (): Promise<GetAttemptOutcome> => ({ ok: true, detail })),
    listAttempts: vi.fn(
      async (): Promise<readonly AcademyQuizAttemptRecord[]> => [attemptRecord()],
    ),
    ...overrides,
  };
  const controller = new QuizAttemptController(service as unknown as QuizAttemptService);
  return { controller, service };
}

function studentRequest(userId = 'student_1'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: false,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

describe('QuizAttemptController.start', () => {
  it('starts an attempt scoped to the authenticated student', async () => {
    const { controller, service } = build();
    const res = await controller.start('quiz_1', studentRequest('s7'));
    expect(res.detail.attempt.id).toBe('attempt_1');
    expect(service.startAttempt).toHaveBeenCalledWith('quiz_1', 's7');
  });

  it('401s without a context', async () => {
    const { controller } = build();
    await expect(
      controller.start('quiz_1', { requestContext: undefined } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('404s a missing quiz', async () => {
    const { controller } = build({
      startAttempt: vi.fn(
        async (): Promise<StartAttemptOutcome> => ({ ok: false, reason: 'quiz_not_found' }),
      ),
    });
    await expect(controller.start('nope', studentRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('409s an under-stocked quiz / in-progress / max-attempts', async () => {
    for (const reason of [
      'insufficient_questions',
      'attempt_in_progress',
      'max_attempts_reached',
    ] as const) {
      const { controller } = build({
        startAttempt: vi.fn(async (): Promise<StartAttemptOutcome> => ({ ok: false, reason })),
      });
      await expect(controller.start('quiz_1', studentRequest())).rejects.toBeInstanceOf(
        ConflictException,
      );
    }
  });

  it('429s while the retake cooldown is active', async () => {
    const retryAfter = new Date('2026-06-08T12:30:00.000Z');
    const { controller } = build({
      startAttempt: vi.fn(
        async (): Promise<StartAttemptOutcome> => ({
          ok: false,
          reason: 'cooldown_active',
          retryAfter,
        }),
      ),
    });
    await expect(controller.start('quiz_1', studentRequest())).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS,
    );
  });
});

describe('QuizAttemptController.submit', () => {
  const body = { answers: [{ questionId: 'q1', selectedOptionIds: ['q1o1'] }] };

  it('submits answers for the authenticated student', async () => {
    const { controller, service } = build();
    await controller.submit('attempt_1', body, studentRequest('s7'));
    expect(service.submitAttempt).toHaveBeenCalledWith('attempt_1', 's7', body.answers);
  });

  it('404s a missing or foreign attempt', async () => {
    const { controller } = build({
      submitAttempt: vi.fn(
        async (): Promise<SubmitAttemptOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.submit('nope', body, studentRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('409s an already-submitted attempt', async () => {
    const { controller } = build({
      submitAttempt: vi.fn(
        async (): Promise<SubmitAttemptOutcome> => ({ ok: false, reason: 'already_submitted' }),
      ),
    });
    await expect(controller.submit('attempt_1', body, studentRequest())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('422s an answer for a question outside the drawn set', async () => {
    const { controller } = build({
      submitAttempt: vi.fn(
        async (): Promise<SubmitAttemptOutcome> => ({
          ok: false,
          reason: 'invalid_question',
          questionId: 'q9',
        }),
      ),
    });
    await expect(controller.submit('attempt_1', body, studentRequest())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});

describe('QuizAttemptController.get / list', () => {
  it('returns one attempt', async () => {
    const { controller } = build();
    expect((await controller.get('attempt_1', studentRequest())).detail.attempt.id).toBe(
      'attempt_1',
    );
  });

  it('404s a missing attempt', async () => {
    const { controller } = build({
      getAttempt: vi.fn(
        async (): Promise<GetAttemptOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.get('nope', studentRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lists the student’s attempts', async () => {
    const { controller, service } = build();
    const res = await controller.list('quiz_1', studentRequest('s7'));
    expect(res.attempts).toHaveLength(1);
    expect(service.listAttempts).toHaveBeenCalledWith('quiz_1', 's7');
  });
});
