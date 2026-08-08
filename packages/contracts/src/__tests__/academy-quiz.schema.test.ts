import { describe, expect, it } from 'vitest';

import {
  AcademyQuizAuthoringTreeSchema,
  AcademyQuizQuestionKindSchema,
  AcademyQuizRecordSchema,
  CreateAcademyQuizQuestionRequestSchema,
  CreateAcademyQuizRequestSchema,
  UpdateAcademyQuizQuestionRequestSchema,
  UpdateAcademyQuizRequestSchema,
} from '../http/academy-quiz.schema';

const TS = '2026-06-08T12:00:00.000Z';

function quizRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    questionCount: 3,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function optionInput(label: string, isCorrect: boolean): Record<string, unknown> {
  return { label, isCorrect };
}

describe('AcademyQuizQuestionKindSchema', () => {
  it('accepts the three kinds', () => {
    for (const kind of ['single_choice', 'multiple_choice', 'true_false']) {
      expect(AcademyQuizQuestionKindSchema.parse(kind)).toBe(kind);
    }
  });

  it('rejects an unknown kind', () => {
    expect(AcademyQuizQuestionKindSchema.safeParse('essay').success).toBe(false);
  });
});

describe('AcademyQuizRecordSchema', () => {
  it('parses a complete record', () => {
    expect(AcademyQuizRecordSchema.parse(quizRecord())).toMatchObject({
      id: 'quiz_1',
      questionCount: 3,
    });
  });

  it('accepts nulled policy fields', () => {
    const parsed = AcademyQuizRecordSchema.parse(
      quizRecord({ maxAttempts: null, retakeCooldownMinutes: null }),
    );
    expect(parsed.maxAttempts).toBeNull();
  });

  it('rejects an unknown field (strict)', () => {
    expect(AcademyQuizRecordSchema.safeParse(quizRecord({ secret: 1 })).success).toBe(false);
  });

  it('rejects a passing score above 100', () => {
    expect(
      AcademyQuizRecordSchema.safeParse(quizRecord({ passingScorePercent: 101 })).success,
    ).toBe(false);
  });
});

describe('CreateAcademyQuizRequestSchema', () => {
  it('accepts a minimal body', () => {
    const parsed = CreateAcademyQuizRequestSchema.parse({
      title: 'T',
      questionsPerAttempt: 2,
      passingScorePercent: 70,
    });
    expect(parsed.questionsPerAttempt).toBe(2);
  });

  it('rejects a missing required field', () => {
    expect(
      CreateAcademyQuizRequestSchema.safeParse({ title: 'T', questionsPerAttempt: 2 }).success,
    ).toBe(false);
  });

  it('rejects questionsPerAttempt below 1', () => {
    expect(
      CreateAcademyQuizRequestSchema.safeParse({
        title: 'T',
        questionsPerAttempt: 0,
        passingScorePercent: 70,
      }).success,
    ).toBe(false);
  });
});

describe('CreateAcademyQuizQuestionRequestSchema correctness rules', () => {
  it('accepts a single_choice with exactly one correct option', () => {
    const parsed = CreateAcademyQuizQuestionRequestSchema.parse({
      prompt: 'P?',
      kind: 'single_choice',
      options: [optionInput('a', true), optionInput('b', false)],
    });
    expect(parsed.options).toHaveLength(2);
  });

  it('rejects a single_choice with zero correct options', () => {
    expect(
      CreateAcademyQuizQuestionRequestSchema.safeParse({
        prompt: 'P?',
        kind: 'single_choice',
        options: [optionInput('a', false), optionInput('b', false)],
      }).success,
    ).toBe(false);
  });

  it('rejects a single_choice with two correct options', () => {
    expect(
      CreateAcademyQuizQuestionRequestSchema.safeParse({
        prompt: 'P?',
        kind: 'single_choice',
        options: [optionInput('a', true), optionInput('b', true)],
      }).success,
    ).toBe(false);
  });

  it('rejects a true_false with three options', () => {
    expect(
      CreateAcademyQuizQuestionRequestSchema.safeParse({
        prompt: 'P?',
        kind: 'true_false',
        options: [optionInput('t', true), optionInput('f', false), optionInput('m', false)],
      }).success,
    ).toBe(false);
  });

  it('accepts a multiple_choice with several correct options', () => {
    const parsed = CreateAcademyQuizQuestionRequestSchema.parse({
      prompt: 'P?',
      kind: 'multiple_choice',
      options: [optionInput('a', true), optionInput('b', true), optionInput('c', false)],
    });
    expect(parsed.options.filter((o) => o.isCorrect)).toHaveLength(2);
  });

  it('rejects a multiple_choice with no correct option', () => {
    expect(
      CreateAcademyQuizQuestionRequestSchema.safeParse({
        prompt: 'P?',
        kind: 'multiple_choice',
        options: [optionInput('a', false), optionInput('b', false)],
      }).success,
    ).toBe(false);
  });

  it('rejects fewer than two options', () => {
    expect(
      CreateAcademyQuizQuestionRequestSchema.safeParse({
        prompt: 'P?',
        kind: 'single_choice',
        options: [optionInput('a', true)],
      }).success,
    ).toBe(false);
  });

  it('defaults isCorrect to false', () => {
    const parsed = CreateAcademyQuizQuestionRequestSchema.parse({
      prompt: 'P?',
      kind: 'single_choice',
      options: [{ label: 'a', isCorrect: true }, { label: 'b' }],
    });
    expect(parsed.options[1]?.isCorrect).toBe(false);
  });
});

describe('UpdateAcademyQuizRequestSchema', () => {
  it('rejects an empty body', () => {
    expect(UpdateAcademyQuizRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts clearing a nullable policy field', () => {
    expect(UpdateAcademyQuizRequestSchema.parse({ maxAttempts: null }).maxAttempts).toBeNull();
  });
});

describe('UpdateAcademyQuizQuestionRequestSchema', () => {
  it('rejects an empty body', () => {
    expect(UpdateAcademyQuizQuestionRequestSchema.safeParse({}).success).toBe(false);
  });

  it('enforces the per-kind rule when kind + options are both supplied', () => {
    expect(
      UpdateAcademyQuizQuestionRequestSchema.safeParse({
        kind: 'single_choice',
        options: [optionInput('a', true), optionInput('b', true)],
      }).success,
    ).toBe(false);
  });

  it('requires at least one correct option when only options are supplied', () => {
    expect(
      UpdateAcademyQuizQuestionRequestSchema.safeParse({
        options: [optionInput('a', false), optionInput('b', false)],
      }).success,
    ).toBe(false);
  });

  it('accepts a scalar-only update', () => {
    expect(UpdateAcademyQuizQuestionRequestSchema.parse({ prompt: 'New?' }).prompt).toBe('New?');
  });
});

describe('AcademyQuizAuthoringTreeSchema', () => {
  it('parses a quiz with its nested question bank', () => {
    const tree = AcademyQuizAuthoringTreeSchema.parse({
      ...quizRecord({ questionCount: 1 }),
      questions: [
        {
          id: 'question_1',
          quizId: 'quiz_1',
          prompt: 'P?',
          kind: 'single_choice',
          points: 1,
          sortPosition: 0,
          options: [
            {
              id: 'o1',
              questionId: 'question_1',
              label: 'a',
              isCorrect: true,
              sortPosition: 0,
              createdAt: TS,
              updatedAt: TS,
            },
          ],
          createdAt: TS,
          updatedAt: TS,
        },
      ],
    });
    expect(tree.questions).toHaveLength(1);
  });
});
