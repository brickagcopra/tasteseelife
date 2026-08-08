import { Decimal } from 'decimal.js';
import type { AcademyQuizQuestionKind } from '@taste-and-see/contracts';

/**
 * Pure quiz scoring + selection logic (TS-254; PRD §9.2–§9.3; PDD §15.1).
 *
 * Extracted from the persistence layer so the load-bearing engine math —
 * randomized N-of-M selection and per-attempt grading — is exhaustively
 * unit-testable without a database (the certification gate, TS-255, reads
 * `passed` off this; CLAUDE.md §9.2 wants 100% coverage on gating logic).
 *
 * Grading is ALL-OR-NOTHING for every kind: an answer scores a question's full
 * `points` only when the student's selected option set equals the question's
 * correct option set exactly — no partial credit in Phase 1 (the contract layer
 * documents the same rule). `single_choice` / `true_false` simply have a
 * one-element correct set, so the unified set-equality check covers them too.
 */

/** An option as the scorer needs it — id + whether it is a correct answer. */
export interface ScorableOption {
  readonly id: string;
  readonly isCorrect: boolean;
}

/** A question as the scorer needs it — kind drives nothing today (set-equality
 * is uniform) but is carried through for the graded-answer reveal. */
export interface ScorableQuestion {
  readonly id: string;
  readonly kind: AcademyQuizQuestionKind;
  readonly points: number;
  readonly options: readonly ScorableOption[];
}

/** The grading outcome for a single question. */
export interface GradedQuestionResult {
  readonly questionId: string;
  readonly correct: boolean;
  readonly pointsAwarded: number;
  readonly pointsPossible: number;
  readonly correctOptionIds: readonly string[];
  /** The student's selection, intersected with the question's real options. */
  readonly selectedOptionIds: readonly string[];
}

/** The full scored attempt. */
export interface ScoredAttempt {
  readonly pointsAwarded: number;
  readonly pointsPossible: number;
  readonly scorePercent: number;
  readonly passed: boolean;
  readonly graded: readonly GradedQuestionResult[];
}

/**
 * Draw `n` items at random from `pool` (a partial Fisher–Yates shuffle of the
 * first `min(n, pool.length)` positions). The `rng` is injected — defaulting to
 * `Math.random` — so tests pin a deterministic sequence. When `n` exceeds the
 * pool size the whole pool is returned (shuffled).
 */
export function drawQuestions<T>(
  pool: readonly T[],
  n: number,
  rng: () => number = Math.random,
): T[] {
  const arr = [...pool];
  const count = Math.min(Math.max(n, 0), arr.length);
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(rng() * (arr.length - i));
    const a = arr[i];
    const b = arr[j];
    // `i` and `j` are always in-bounds; the guard satisfies
    // noUncheckedIndexedAccess without changing behaviour.
    if (a === undefined || b === undefined) continue;
    arr[i] = b;
    arr[j] = a;
  }
  return arr.slice(0, count);
}

/**
 * Grade one question against the student's selected option ids. Selections that
 * are not real options of the question are ignored (intersected away), so a
 * stray id never penalises beyond failing the set-equality check.
 */
export function gradeQuestion(
  question: ScorableQuestion,
  selectedOptionIds: readonly string[],
): GradedQuestionResult {
  const optionIds = new Set(question.options.map((o) => o.id));
  const correctOptionIds = question.options.filter((o) => o.isCorrect).map((o) => o.id);
  const correctSet = new Set(correctOptionIds);

  // Intersect the student's choice with the question's real, de-duplicated options.
  const selectedSet = new Set(selectedOptionIds.filter((id) => optionIds.has(id)));

  const correct =
    selectedSet.size === correctSet.size && [...correctSet].every((id) => selectedSet.has(id));

  return {
    questionId: question.id,
    correct,
    pointsAwarded: correct ? question.points : 0,
    pointsPossible: question.points,
    correctOptionIds,
    selectedOptionIds: [...selectedSet],
  };
}

/**
 * Score an attempt over its drawn questions (in order). `answersByQuestionId`
 * maps a question id to the student's selected option ids; a drawn question with
 * no entry scores zero (unanswered). The percent is computed once with Decimal
 * (round-half-up to a whole percent) to avoid binary-float drift on the
 * certification gate. `passed` is `scorePercent >= passingScorePercent`.
 */
export function scoreAttempt(
  questions: readonly ScorableQuestion[],
  answersByQuestionId: ReadonlyMap<string, readonly string[]>,
  passingScorePercent: number,
): ScoredAttempt {
  const graded = questions.map((q) => gradeQuestion(q, answersByQuestionId.get(q.id) ?? []));

  const pointsAwarded = graded.reduce((sum, g) => sum + g.pointsAwarded, 0);
  const pointsPossible = graded.reduce((sum, g) => sum + g.pointsPossible, 0);

  const scorePercent =
    pointsPossible === 0
      ? 0
      : new Decimal(pointsAwarded)
          .div(pointsPossible)
          .times(100)
          .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
          .toNumber();

  return {
    pointsAwarded,
    pointsPossible,
    scorePercent,
    passed: scorePercent >= passingScorePercent,
    graded,
  };
}
