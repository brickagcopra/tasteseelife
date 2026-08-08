import { describe, expect, it } from 'vitest';

import {
  AcademyQuizAttemptDetailResponseSchema,
  AcademyQuizAttemptRecordSchema,
  AcademyQuizAttemptStatusSchema,
  GradedQuizAnswerSchema,
  PresentedQuizQuestionSchema,
  SubmitQuizAttemptRequestSchema,
} from '../http/academy-quiz-attempt.schema';

const TS = '2026-06-08T12:00:00.000Z';

function attemptRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

describe('AcademyQuizAttemptStatusSchema', () => {
  it('accepts the two statuses and rejects others', () => {
    expect(AcademyQuizAttemptStatusSchema.parse('in_progress')).toBe('in_progress');
    expect(AcademyQuizAttemptStatusSchema.parse('submitted')).toBe('submitted');
    expect(AcademyQuizAttemptStatusSchema.safeParse('graded').success).toBe(false);
  });
});

describe('PresentedQuizQuestionSchema', () => {
  it('parses a presented question with options', () => {
    const parsed = PresentedQuizQuestionSchema.parse({
      id: 'q1',
      prompt: 'Q?',
      kind: 'single_choice',
      points: 1,
      options: [{ id: 'o1', label: 'a', sortPosition: 0 }],
    });
    expect(parsed.options[0]?.id).toBe('o1');
  });

  it('rejects an option that leaks isCorrect (strict — no answer key on the wire)', () => {
    expect(
      PresentedQuizQuestionSchema.safeParse({
        id: 'q1',
        prompt: 'Q?',
        kind: 'single_choice',
        points: 1,
        options: [{ id: 'o1', label: 'a', sortPosition: 0, isCorrect: true }],
      }).success,
    ).toBe(false);
  });
});

describe('AcademyQuizAttemptRecordSchema', () => {
  it('parses an in-progress attempt with null scoring fields', () => {
    const parsed = AcademyQuizAttemptRecordSchema.parse(attemptRecord());
    expect(parsed.scorePercent).toBeNull();
    expect(parsed.passed).toBeNull();
  });

  it('parses a submitted attempt with scores', () => {
    const parsed = AcademyQuizAttemptRecordSchema.parse(
      attemptRecord({
        status: 'submitted',
        pointsAwarded: 2,
        pointsPossible: 3,
        scorePercent: 67,
        passed: false,
        submittedAt: TS,
      }),
    );
    expect(parsed.scorePercent).toBe(67);
  });

  it('rejects a score percent above 100', () => {
    expect(
      AcademyQuizAttemptRecordSchema.safeParse(attemptRecord({ scorePercent: 101 })).success,
    ).toBe(false);
  });
});

describe('GradedQuizAnswerSchema', () => {
  it('parses a graded answer revealing correct options', () => {
    const parsed = GradedQuizAnswerSchema.parse({
      questionId: 'q1',
      prompt: 'Q?',
      kind: 'single_choice',
      selectedOptionIds: ['o2'],
      correctOptionIds: ['o1'],
      correct: false,
      pointsAwarded: 0,
      pointsPossible: 1,
    });
    expect(parsed.correctOptionIds).toEqual(['o1']);
  });
});

describe('SubmitQuizAttemptRequestSchema', () => {
  it('accepts answers (including an empty set = all unanswered)', () => {
    expect(SubmitQuizAttemptRequestSchema.parse({ answers: [] }).answers).toEqual([]);
    const parsed = SubmitQuizAttemptRequestSchema.parse({
      answers: [{ questionId: 'q1', selectedOptionIds: ['o1'] }],
    });
    expect(parsed.answers).toHaveLength(1);
  });

  it('rejects a duplicate questionId across answers', () => {
    expect(
      SubmitQuizAttemptRequestSchema.safeParse({
        answers: [
          { questionId: 'q1', selectedOptionIds: ['o1'] },
          { questionId: 'q1', selectedOptionIds: ['o2'] },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a duplicate option id within one answer', () => {
    expect(
      SubmitQuizAttemptRequestSchema.safeParse({
        answers: [{ questionId: 'q1', selectedOptionIds: ['o1', 'o1'] }],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    expect(SubmitQuizAttemptRequestSchema.safeParse({ answers: [], extra: true }).success).toBe(
      false,
    );
  });
});

describe('AcademyQuizAttemptDetailResponseSchema', () => {
  it('parses the start/submit/get envelope', () => {
    const parsed = AcademyQuizAttemptDetailResponseSchema.parse({
      detail: {
        attempt: attemptRecord(),
        questions: [{ id: 'q1', prompt: 'Q?', kind: 'single_choice', points: 1, options: [] }],
        answers: [],
      },
    });
    expect(parsed.detail.questions).toHaveLength(1);
  });
});
