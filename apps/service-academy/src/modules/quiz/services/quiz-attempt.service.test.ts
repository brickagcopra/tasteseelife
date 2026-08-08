import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { FakeAcademyQuizPrisma } from './__fixtures__/fake-prisma';
import { QuizAttemptService } from './quiz-attempt.service';

const NOW = new Date('2026-06-08T12:00:00.000Z');
const STUDENT = 'student_1';

interface QuizSeed {
  questionsPerAttempt?: number;
  passingScorePercent?: number;
  maxAttempts?: number | null;
  retakeCooldownMinutes?: number | null;
  shuffleQuestions?: boolean;
}

/** Seed a quiz `quiz_1` with three single-choice questions (first option correct). */
function seedQuiz(prisma: FakeAcademyQuizPrisma, seed: QuizSeed = {}): void {
  prisma.academyQuiz.seed({
    id: 'quiz_1',
    lessonId: 'lesson_1',
    title: 'T',
    instructions: null,
    questionsPerAttempt: seed.questionsPerAttempt ?? 2,
    passingScorePercent: seed.passingScorePercent ?? 50,
    maxAttempts: seed.maxAttempts ?? null,
    retakeCooldownMinutes: seed.retakeCooldownMinutes ?? null,
    shuffleQuestions: seed.shuffleQuestions ?? true,
    bankVersion: 1,
  } as never);

  for (const i of [1, 2, 3]) {
    prisma.academyQuizQuestion.seed({
      id: `q${i}`,
      quizId: 'quiz_1',
      prompt: `Question ${i}?`,
      kind: 'single_choice',
      points: 1,
      sortPosition: i - 1,
      deletedAt: null,
    } as never);
    prisma.academyQuizQuestionOption.seed({
      id: `q${i}o1`,
      questionId: `q${i}`,
      label: 'right',
      isCorrect: true,
      sortPosition: 0,
    } as never);
    prisma.academyQuizQuestionOption.seed({
      id: `q${i}o2`,
      questionId: `q${i}`,
      label: 'wrong',
      isCorrect: false,
      sortPosition: 1,
    } as never);
  }
}

function build(seed: QuizSeed = {}): {
  service: QuizAttemptService;
  prisma: FakeAcademyQuizPrisma;
} {
  const prisma = new FakeAcademyQuizPrisma();
  seedQuiz(prisma, seed);
  // rng=()=>0 draws the first N of the (sortPosition-ordered) pool → q1, q2.
  const service = new QuizAttemptService(
    prisma as unknown as PrismaService,
    () => NOW,
    () => 0,
  );
  return { service, prisma };
}

describe('QuizAttemptService.startAttempt', () => {
  it('draws the configured number of questions without leaking correctness', async () => {
    const { service } = build();
    const outcome = await service.startAttempt('quiz_1', STUDENT);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.detail.attempt.status).toBe('in_progress');
      expect(outcome.detail.attempt.attemptNumber).toBe(1);
      expect(outcome.detail.attempt.bankVersion).toBe(1);
      expect(outcome.detail.attempt.questionIds).toEqual(['q1', 'q2']);
      expect(outcome.detail.answers).toEqual([]);
      expect(outcome.detail.questions).toHaveLength(2);
      const option = outcome.detail.questions[0]?.options[0];
      expect(option).toBeDefined();
      expect(option).not.toHaveProperty('isCorrect');
    }
  });

  it('rejects when the bank has fewer active questions than the draw size', async () => {
    const { service } = build({ questionsPerAttempt: 5 });
    expect(await service.startAttempt('quiz_1', STUDENT)).toEqual({
      ok: false,
      reason: 'insufficient_questions',
    });
  });

  it('404s on a missing quiz', async () => {
    const { service } = build();
    expect(await service.startAttempt('nope', STUDENT)).toEqual({
      ok: false,
      reason: 'quiz_not_found',
    });
  });

  it('rejects when an attempt is already in progress', async () => {
    const { service, prisma } = build();
    prisma.academyQuizAttempt.seed({
      id: 'a_open',
      quizId: 'quiz_1',
      studentUserId: STUDENT,
      status: 'in_progress',
      attemptNumber: 1,
      bankVersion: 1,
      questionIds: ['q1', 'q2'],
      startedAt: NOW,
    } as never);
    expect(await service.startAttempt('quiz_1', STUDENT)).toEqual({
      ok: false,
      reason: 'attempt_in_progress',
    });
  });

  it('rejects at the max-attempts cap', async () => {
    const { service, prisma } = build({ maxAttempts: 1 });
    prisma.academyQuizAttempt.seed({
      id: 'a_done',
      quizId: 'quiz_1',
      studentUserId: STUDENT,
      status: 'submitted',
      attemptNumber: 1,
      bankVersion: 1,
      questionIds: ['q1', 'q2'],
      startedAt: NOW,
      submittedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);
    expect(await service.startAttempt('quiz_1', STUDENT)).toEqual({
      ok: false,
      reason: 'max_attempts_reached',
    });
  });

  it('rejects while the retake cooldown is active, carrying retryAfter', async () => {
    const { service, prisma } = build({ retakeCooldownMinutes: 60 });
    prisma.academyQuizAttempt.seed({
      id: 'a_recent',
      quizId: 'quiz_1',
      studentUserId: STUDENT,
      status: 'submitted',
      attemptNumber: 1,
      bankVersion: 1,
      questionIds: ['q1', 'q2'],
      startedAt: new Date('2026-06-08T11:30:00.000Z'),
      submittedAt: new Date('2026-06-08T11:30:00.000Z'),
    } as never);
    const outcome = await service.startAttempt('quiz_1', STUDENT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === 'cooldown_active') {
      expect(outcome.retryAfter.toISOString()).toBe('2026-06-08T12:30:00.000Z');
    } else {
      throw new Error('expected cooldown_active');
    }
  });
});

describe('QuizAttemptService.submitAttempt', () => {
  async function start(service: QuizAttemptService): Promise<string> {
    const outcome = await service.startAttempt('quiz_1', STUDENT);
    if (!outcome.ok) throw new Error('start failed');
    return outcome.detail.attempt.id;
  }

  it('grades a perfect attempt as passed and reveals correct options', async () => {
    const { service } = build({ passingScorePercent: 50 });
    const attemptId = await start(service);
    const outcome = await service.submitAttempt(attemptId, STUDENT, [
      { questionId: 'q1', selectedOptionIds: ['q1o1'] },
      { questionId: 'q2', selectedOptionIds: ['q2o1'] },
    ]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.detail.attempt.status).toBe('submitted');
      expect(outcome.detail.attempt.scorePercent).toBe(100);
      expect(outcome.detail.attempt.passed).toBe(true);
      expect(outcome.detail.attempt.submittedAt).toBe(NOW.toISOString());
      expect(outcome.detail.answers).toHaveLength(2);
      expect(outcome.detail.answers[0]?.correctOptionIds).toEqual(['q1o1']);
      expect(outcome.detail.answers.every((a) => a.correct)).toBe(true);
    }
  });

  it('fails an attempt below the threshold', async () => {
    const { service } = build({ passingScorePercent: 80 });
    const attemptId = await start(service);
    const outcome = await service.submitAttempt(attemptId, STUDENT, [
      { questionId: 'q1', selectedOptionIds: ['q1o1'] }, // correct
      { questionId: 'q2', selectedOptionIds: ['q2o2'] }, // wrong
    ]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.detail.attempt.scorePercent).toBe(50);
      expect(outcome.detail.attempt.passed).toBe(false);
    }
  });

  it('rejects an answer for a question outside the drawn set', async () => {
    const { service } = build();
    const attemptId = await start(service);
    const outcome = await service.submitAttempt(attemptId, STUDENT, [
      { questionId: 'q3', selectedOptionIds: ['q3o1'] },
    ]);
    expect(outcome).toEqual({ ok: false, reason: 'invalid_question', questionId: 'q3' });
  });

  it('404s a foreign or missing attempt (never another student’s row)', async () => {
    const { service } = build();
    const attemptId = await start(service);
    expect(await service.submitAttempt(attemptId, 'someone_else', [])).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await service.submitAttempt('nope', STUDENT, [])).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('rejects a second submit of the same attempt', async () => {
    const { service } = build();
    const attemptId = await start(service);
    await service.submitAttempt(attemptId, STUDENT, [
      { questionId: 'q1', selectedOptionIds: ['q1o1'] },
    ]);
    expect(await service.submitAttempt(attemptId, STUDENT, [])).toEqual({
      ok: false,
      reason: 'already_submitted',
    });
  });

  it('scores an unanswered drawn question as zero', async () => {
    const { service } = build({ passingScorePercent: 50 });
    const attemptId = await start(service);
    const outcome = await service.submitAttempt(attemptId, STUDENT, [
      { questionId: 'q1', selectedOptionIds: ['q1o1'] }, // q2 unanswered
    ]);
    if (outcome.ok) {
      expect(outcome.detail.attempt.scorePercent).toBe(50);
      expect(outcome.detail.attempt.passed).toBe(true);
    }
  });
});

describe('QuizAttemptService.getAttempt / listAttempts', () => {
  it('returns an in-progress attempt with no graded answers', async () => {
    const { service } = build();
    const started = await service.startAttempt('quiz_1', STUDENT);
    if (!started.ok) throw new Error('start failed');
    const got = await service.getAttempt(started.detail.attempt.id, STUDENT);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.detail.attempt.status).toBe('in_progress');
      expect(got.detail.questions).toHaveLength(2);
      expect(got.detail.answers).toEqual([]);
    }
  });

  it('reveals graded answers after submit', async () => {
    const { service } = build();
    const started = await service.startAttempt('quiz_1', STUDENT);
    if (!started.ok) throw new Error('start failed');
    const id = started.detail.attempt.id;
    await service.submitAttempt(id, STUDENT, [
      { questionId: 'q1', selectedOptionIds: ['q1o1'] },
      { questionId: 'q2', selectedOptionIds: ['q2o2'] },
    ]);
    const got = await service.getAttempt(id, STUDENT);
    if (got.ok) {
      expect(got.detail.answers).toHaveLength(2);
      const a1 = got.detail.answers.find((a) => a.questionId === 'q1');
      expect(a1?.correct).toBe(true);
      expect(a1?.correctOptionIds).toEqual(['q1o1']);
    }
  });

  it('404s another student’s attempt', async () => {
    const { service } = build();
    const started = await service.startAttempt('quiz_1', STUDENT);
    if (!started.ok) throw new Error('start failed');
    expect(await service.getAttempt(started.detail.attempt.id, 'intruder')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('lists the student’s own attempts, newest first', async () => {
    const { service, prisma } = build({ maxAttempts: 5 });
    prisma.academyQuizAttempt.seed({
      id: 'a1',
      quizId: 'quiz_1',
      studentUserId: STUDENT,
      status: 'submitted',
      attemptNumber: 1,
      bankVersion: 1,
      questionIds: ['q1', 'q2'],
      startedAt: NOW,
      submittedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);
    prisma.academyQuizAttempt.seed({
      id: 'a2',
      quizId: 'quiz_1',
      studentUserId: STUDENT,
      status: 'submitted',
      attemptNumber: 2,
      bankVersion: 1,
      questionIds: ['q1', 'q2'],
      startedAt: NOW,
      submittedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);
    prisma.academyQuizAttempt.seed({
      id: 'other',
      quizId: 'quiz_1',
      studentUserId: 'someone_else',
      status: 'submitted',
      attemptNumber: 1,
      bankVersion: 1,
      questionIds: ['q1', 'q2'],
      startedAt: NOW,
      submittedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);
    const list = await service.listAttempts('quiz_1', STUDENT);
    expect(list.map((a) => a.id)).toEqual(['a2', 'a1']);
  });
});
