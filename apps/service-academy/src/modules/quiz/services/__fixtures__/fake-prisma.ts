/**
 * In-memory Prisma fake for the quiz-engine service unit tests (TS-254).
 *
 * Reuses the shared `FakeTable` (the catalog fixtures) — which implements the
 * narrow `findFirst` / `findMany` / `create` / `update` / `count` / `delete` /
 * `deleteMany` surface plus `{ increment }` update operators — and composes the
 * quiz tables under their Prisma accessor names. The real FK / cascade behaviour
 * + transactional guarantees are covered by the Testcontainers integration test
 * (TS-254-followup); this fake pins the services' branching logic. Excluded from
 * the build + coverage globs (it lives under `__fixtures__/`).
 */
import { FakeTable } from '../../../catalog/services/__fixtures__/fake-prisma';

/** Composes the quiz-engine tables (+ `academyLesson` for the create-quiz check). */
export class FakeAcademyQuizPrisma {
  readonly academyLesson = new FakeTable('lesson', {});
  readonly academyQuiz = new FakeTable('quiz', { instructions: null, bankVersion: 1 });
  readonly academyQuizQuestion = new FakeTable('question', { deletedAt: null });
  readonly academyQuizQuestionOption = new FakeTable('option', {});
  readonly academyQuizAttempt = new FakeTable('attempt', {
    // `startedAt` is a DB `@default(now())` the fake must supply so the
    // attempt-record mapper's `startedAt.toISOString()` has a Date to read.
    startedAt: new Date('2026-06-01T00:00:00.000Z'),
    pointsAwarded: null,
    pointsPossible: null,
    scorePercent: null,
    passed: null,
    submittedAt: null,
  });
  readonly academyQuizAttemptAnswer = new FakeTable('answer', {});
}
