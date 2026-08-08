import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { FakeAcademyQuizPrisma } from './__fixtures__/fake-prisma';
import { QuizAuthoringService } from './quiz-authoring.service';

function build(): { service: QuizAuthoringService; prisma: FakeAcademyQuizPrisma } {
  const prisma = new FakeAcademyQuizPrisma();
  const service = new QuizAuthoringService(prisma as unknown as PrismaService);
  return { service, prisma };
}

function seedQuizLesson(prisma: FakeAcademyQuizPrisma, id = 'lesson_1', kind = 'quiz'): void {
  prisma.academyLesson.seed({ id, kind } as never);
}

const ACTOR = 'admin_1';

const quizBody = {
  title: 'Knife safety',
  questionsPerAttempt: 2,
  passingScorePercent: 70,
};

const questionBody = {
  prompt: 'Which grip is safest?',
  kind: 'single_choice' as const,
  options: [
    { label: 'Claw grip', isCorrect: true, sortPosition: 0 },
    { label: 'Loose grip', isCorrect: false, sortPosition: 1 },
  ],
};

describe('QuizAuthoringService.createQuiz', () => {
  it('creates a quiz on a quiz-kind lesson', async () => {
    const { service, prisma } = build();
    seedQuizLesson(prisma);
    const outcome = await service.createQuiz({
      ...quizBody,
      lessonId: 'lesson_1',
      actorUserId: ACTOR,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.quiz.lessonId).toBe('lesson_1');
      expect(outcome.quiz.questionCount).toBe(0);
      expect(outcome.quiz.bankVersion).toBe(1);
      expect(outcome.quiz.shuffleQuestions).toBe(true);
    }
  });

  it('rejects when the lesson is missing', async () => {
    const { service } = build();
    const outcome = await service.createQuiz({ ...quizBody, lessonId: 'nope', actorUserId: ACTOR });
    expect(outcome).toEqual({ ok: false, reason: 'lesson_not_found' });
  });

  it('rejects when the lesson is not a quiz lesson', async () => {
    const { service, prisma } = build();
    seedQuizLesson(prisma, 'lesson_v', 'video');
    const outcome = await service.createQuiz({
      ...quizBody,
      lessonId: 'lesson_v',
      actorUserId: ACTOR,
    });
    expect(outcome).toEqual({ ok: false, reason: 'lesson_not_quiz' });
  });

  it('rejects a second quiz on the same lesson', async () => {
    const { service, prisma } = build();
    seedQuizLesson(prisma);
    await service.createQuiz({ ...quizBody, lessonId: 'lesson_1', actorUserId: ACTOR });
    const second = await service.createQuiz({
      ...quizBody,
      lessonId: 'lesson_1',
      actorUserId: ACTOR,
    });
    expect(second).toEqual({ ok: false, reason: 'quiz_exists' });
  });
});

describe('QuizAuthoringService questions', () => {
  async function seedQuizWithQuestion(): Promise<{
    service: QuizAuthoringService;
    prisma: FakeAcademyQuizPrisma;
    quizId: string;
    questionId: string;
  }> {
    const { service, prisma } = build();
    seedQuizLesson(prisma);
    const quizOutcome = await service.createQuiz({
      ...quizBody,
      lessonId: 'lesson_1',
      actorUserId: ACTOR,
    });
    if (!quizOutcome.ok) throw new Error('quiz create failed');
    const quizId = quizOutcome.quiz.id;
    const qOutcome = await service.createQuestion({ ...questionBody, quizId, actorUserId: ACTOR });
    if (!qOutcome.ok) throw new Error('question create failed');
    return { service, prisma, quizId, questionId: qOutcome.question.id };
  }

  it('creates a question with ordered options and bumps bankVersion', async () => {
    const { service, quizId, questionId } = await seedQuizWithQuestion();
    const tree = await service.getAuthoringTree('lesson_1');
    expect(tree.ok).toBe(true);
    if (tree.ok) {
      expect(tree.quiz.bankVersion).toBe(2); // 1 (create) + 1 (question)
      expect(tree.quiz.questionCount).toBe(1);
      expect(tree.quiz.questions).toHaveLength(1);
      const question = tree.quiz.questions[0];
      expect(question?.id).toBe(questionId);
      expect(question?.options.map((o) => o.label)).toEqual(['Claw grip', 'Loose grip']);
      expect(question?.options.filter((o) => o.isCorrect)).toHaveLength(1);
    }
    expect(quizId).toBeTruthy();
  });

  it('rejects creating a question on a missing quiz', async () => {
    const { service } = build();
    const outcome = await service.createQuestion({
      ...questionBody,
      quizId: 'nope',
      actorUserId: ACTOR,
    });
    expect(outcome).toEqual({ ok: false, reason: 'quiz_not_found' });
  });

  it('replaces options on update and bumps bankVersion again', async () => {
    const { service, questionId } = await seedQuizWithQuestion();
    const outcome = await service.updateQuestion({
      questionId,
      kind: 'multiple_choice',
      options: [
        { label: 'A', isCorrect: true, sortPosition: 0 },
        { label: 'B', isCorrect: true, sortPosition: 1 },
        { label: 'C', isCorrect: false, sortPosition: 2 },
      ],
      actorUserId: ACTOR,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.question.kind).toBe('multiple_choice');
      expect(outcome.question.options).toHaveLength(3);
      expect(outcome.question.options.filter((o) => o.isCorrect)).toHaveLength(2);
    }
    const tree = await service.getAuthoringTree('lesson_1');
    if (tree.ok) expect(tree.quiz.bankVersion).toBe(3); // create + question + update
  });

  it('404s updating a missing question', async () => {
    const { service } = build();
    const outcome = await service.updateQuestion({
      questionId: 'nope',
      prompt: 'x',
      actorUserId: ACTOR,
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
  });

  it('soft-deletes a question (removed from the tree) and bumps bankVersion', async () => {
    const { service, questionId } = await seedQuizWithQuestion();
    const outcome = await service.softDeleteQuestion(questionId, ACTOR);
    expect(outcome).toEqual({ ok: true });
    const tree = await service.getAuthoringTree('lesson_1');
    if (tree.ok) {
      expect(tree.quiz.questions).toHaveLength(0);
      expect(tree.quiz.questionCount).toBe(0);
      expect(tree.quiz.bankVersion).toBe(3);
    }
  });
});

describe('QuizAuthoringService.updateQuiz / deleteQuiz / getAuthoringTree', () => {
  it('updates quiz config and reports the live question count', async () => {
    const { service, prisma } = build();
    seedQuizLesson(prisma);
    const created = await service.createQuiz({
      ...quizBody,
      lessonId: 'lesson_1',
      actorUserId: ACTOR,
    });
    if (!created.ok) throw new Error('create failed');
    const outcome = await service.updateQuiz({
      quizId: created.quiz.id,
      passingScorePercent: 90,
      maxAttempts: 3,
      actorUserId: ACTOR,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.quiz.passingScorePercent).toBe(90);
      expect(outcome.quiz.maxAttempts).toBe(3);
      expect(outcome.quiz.questionCount).toBe(0);
    }
  });

  it('404s updating a missing quiz', async () => {
    const { service } = build();
    expect(await service.updateQuiz({ quizId: 'nope', title: 'x', actorUserId: ACTOR })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('404s the authoring tree for a lesson with no quiz', async () => {
    const { service } = build();
    expect(await service.getAuthoringTree('lesson_x')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('deletes a quiz with no attempts', async () => {
    const { service, prisma } = build();
    seedQuizLesson(prisma);
    const created = await service.createQuiz({
      ...quizBody,
      lessonId: 'lesson_1',
      actorUserId: ACTOR,
    });
    if (!created.ok) throw new Error('create failed');
    expect(await service.deleteQuiz(created.quiz.id, ACTOR)).toEqual({ ok: true });
  });

  it('refuses to delete a quiz that has attempts', async () => {
    const { service, prisma } = build();
    seedQuizLesson(prisma);
    const created = await service.createQuiz({
      ...quizBody,
      lessonId: 'lesson_1',
      actorUserId: ACTOR,
    });
    if (!created.ok) throw new Error('create failed');
    prisma.academyQuizAttempt.seed({ id: 'attempt_1', quizId: created.quiz.id } as never);
    expect(await service.deleteQuiz(created.quiz.id, ACTOR)).toEqual({
      ok: false,
      reason: 'has_attempts',
    });
  });

  it('404s deleting a missing quiz', async () => {
    const { service } = build();
    expect(await service.deleteQuiz('nope', ACTOR)).toEqual({ ok: false, reason: 'not_found' });
  });
});
