import { describe, expect, it } from 'vitest';

import { drawQuestions, gradeQuestion, scoreAttempt, type ScorableQuestion } from './quiz-scoring';

/** A scorable question helper. */
function q(
  id: string,
  kind: ScorableQuestion['kind'],
  options: ReadonlyArray<[string, boolean]>,
  points = 1,
): ScorableQuestion {
  return {
    id,
    kind,
    points,
    options: options.map(([oid, isCorrect]) => ({ id: oid, isCorrect })),
  };
}

/** A deterministic RNG that replays a fixed sequence (then 0s). */
function seededRng(seq: readonly number[]): () => number {
  let i = 0;
  return () => seq[i++] ?? 0;
}

describe('drawQuestions', () => {
  const pool = ['a', 'b', 'c', 'd', 'e'] as const;

  it('with an all-zero rng draws the first N in pool order', () => {
    expect(drawQuestions(pool, 3, () => 0)).toEqual(['a', 'b', 'c']);
  });

  it('draws exactly N distinct items, all from the pool', () => {
    const drawn = drawQuestions(pool, 3, seededRng([0.9, 0.1, 0.5, 0.3]));
    expect(drawn).toHaveLength(3);
    expect(new Set(drawn).size).toBe(3);
    for (const item of drawn) expect(pool).toContain(item);
  });

  it('returns the whole (shuffled) pool when N exceeds its size', () => {
    const drawn = drawQuestions(pool, 99, seededRng([0.5, 0.5, 0.5]));
    expect([...drawn].sort()).toEqual([...pool].sort());
  });

  it('returns an empty array for N <= 0', () => {
    expect(drawQuestions(pool, 0, () => 0)).toEqual([]);
    expect(drawQuestions(pool, -3, () => 0)).toEqual([]);
  });

  it('does not mutate the input pool', () => {
    const original = [...pool];
    drawQuestions(pool, 4, seededRng([0.7, 0.2, 0.9]));
    expect(pool).toEqual(original);
  });
});

describe('gradeQuestion', () => {
  it('single_choice: the one correct option is correct', () => {
    const result = gradeQuestion(
      q(
        'q1',
        'single_choice',
        [
          ['a', true],
          ['b', false],
        ],
        2,
      ),
      ['a'],
    );
    expect(result.correct).toBe(true);
    expect(result.pointsAwarded).toBe(2);
    expect(result.correctOptionIds).toEqual(['a']);
  });

  it('single_choice: a wrong pick scores zero', () => {
    const result = gradeQuestion(
      q('q1', 'single_choice', [
        ['a', true],
        ['b', false],
      ]),
      ['b'],
    );
    expect(result.correct).toBe(false);
    expect(result.pointsAwarded).toBe(0);
  });

  it('single_choice: selecting two options never counts (set mismatch)', () => {
    const result = gradeQuestion(
      q('q1', 'single_choice', [
        ['a', true],
        ['b', false],
      ]),
      ['a', 'b'],
    );
    expect(result.correct).toBe(false);
  });

  it('multiple_choice: the exact correct set is correct', () => {
    const result = gradeQuestion(
      q(
        'q1',
        'multiple_choice',
        [
          ['a', true],
          ['b', true],
          ['c', false],
        ],
        3,
      ),
      ['b', 'a'],
    );
    expect(result.correct).toBe(true);
    expect(result.pointsAwarded).toBe(3);
  });

  it('multiple_choice: a missing correct option fails', () => {
    const result = gradeQuestion(
      q('q1', 'multiple_choice', [
        ['a', true],
        ['b', true],
        ['c', false],
      ]),
      ['a'],
    );
    expect(result.correct).toBe(false);
  });

  it('multiple_choice: an extra wrong option fails (all-or-nothing)', () => {
    const result = gradeQuestion(
      q('q1', 'multiple_choice', [
        ['a', true],
        ['b', true],
        ['c', false],
      ]),
      ['a', 'b', 'c'],
    );
    expect(result.correct).toBe(false);
  });

  it('true_false: the correct boolean option is correct', () => {
    const result = gradeQuestion(
      q('q1', 'true_false', [
        ['t', true],
        ['f', false],
      ]),
      ['t'],
    );
    expect(result.correct).toBe(true);
  });

  it('ignores option ids that do not belong to the question', () => {
    const result = gradeQuestion(
      q('q1', 'single_choice', [
        ['a', true],
        ['b', false],
      ]),
      ['a', 'ghost'],
    );
    expect(result.correct).toBe(true);
    expect(result.selectedOptionIds).toEqual(['a']);
  });

  it('de-duplicates a repeated selection before grading', () => {
    const result = gradeQuestion(
      q('q1', 'single_choice', [
        ['a', true],
        ['b', false],
      ]),
      ['a', 'a'],
    );
    expect(result.correct).toBe(true);
  });

  it('an empty selection on a question with a correct answer is wrong', () => {
    const result = gradeQuestion(
      q('q1', 'single_choice', [
        ['a', true],
        ['b', false],
      ]),
      [],
    );
    expect(result.correct).toBe(false);
    expect(result.pointsAwarded).toBe(0);
  });
});

describe('scoreAttempt', () => {
  const questions: ScorableQuestion[] = [
    q(
      'q1',
      'single_choice',
      [
        ['a', true],
        ['b', false],
      ],
      1,
    ),
    q(
      'q2',
      'single_choice',
      [
        ['c', true],
        ['d', false],
      ],
      1,
    ),
    q(
      'q3',
      'multiple_choice',
      [
        ['e', true],
        ['f', true],
        ['g', false],
      ],
      1,
    ),
  ];

  it('scores a perfect attempt at 100% and passes', () => {
    const answers = new Map<string, readonly string[]>([
      ['q1', ['a']],
      ['q2', ['c']],
      ['q3', ['e', 'f']],
    ]);
    const scored = scoreAttempt(questions, answers, 70);
    expect(scored.pointsAwarded).toBe(3);
    expect(scored.pointsPossible).toBe(3);
    expect(scored.scorePercent).toBe(100);
    expect(scored.passed).toBe(true);
  });

  it('rounds half-up: 2 of 3 correct → 67%', () => {
    const answers = new Map<string, readonly string[]>([
      ['q1', ['a']],
      ['q2', ['c']],
      ['q3', ['e']], // missing f → wrong
    ]);
    const scored = scoreAttempt(questions, answers, 70);
    expect(scored.scorePercent).toBe(67); // 66.66.. → 67
    expect(scored.passed).toBe(false);
  });

  it('treats an unanswered drawn question as zero', () => {
    const answers = new Map<string, readonly string[]>([['q1', ['a']]]);
    const scored = scoreAttempt(questions, answers, 30);
    expect(scored.pointsAwarded).toBe(1);
    expect(scored.scorePercent).toBe(33); // 1/3
    expect(scored.passed).toBe(true); // 33 >= 30
  });

  it('weights by question points', () => {
    const weighted: ScorableQuestion[] = [
      q(
        'q1',
        'single_choice',
        [
          ['a', true],
          ['b', false],
        ],
        1,
      ),
      q(
        'q2',
        'single_choice',
        [
          ['c', true],
          ['d', false],
        ],
        3,
      ),
    ];
    // Only the 3-point question correct → 3/4 = 75%.
    const answers = new Map<string, readonly string[]>([['q2', ['c']]]);
    const scored = scoreAttempt(weighted, answers, 75);
    expect(scored.pointsAwarded).toBe(3);
    expect(scored.pointsPossible).toBe(4);
    expect(scored.scorePercent).toBe(75);
    expect(scored.passed).toBe(true); // boundary: >= passes
  });

  it('passing is inclusive of the threshold', () => {
    const single: ScorableQuestion[] = [
      q('q1', 'single_choice', [
        ['a', true],
        ['b', false],
      ]),
    ];
    const scored = scoreAttempt(single, new Map([['q1', ['a']]]), 100);
    expect(scored.scorePercent).toBe(100);
    expect(scored.passed).toBe(true);
  });

  it('an all-zero-points-possible attempt scores 0% and only passes at threshold 0', () => {
    const scored = scoreAttempt([], new Map(), 0);
    expect(scored.scorePercent).toBe(0);
    expect(scored.passed).toBe(true);
    const scoredStrict = scoreAttempt([], new Map(), 1);
    expect(scoredStrict.passed).toBe(false);
  });

  it('returns one graded result per question, in order', () => {
    const scored = scoreAttempt(questions, new Map(), 50);
    expect(scored.graded.map((g) => g.questionId)).toEqual(['q1', 'q2', 'q3']);
  });
});
