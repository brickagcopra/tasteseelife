import { Module } from '@nestjs/common';

import { QuizAdminController } from './controllers/quiz-admin.controller';
import { QuizAttemptController } from './controllers/quiz-attempt.controller';
import { QuizAttemptService } from './services/quiz-attempt.service';
import { QuizAuthoringService } from './services/quiz-authoring.service';

/**
 * Quiz-engine bounded module (TS-254; PRD §9.2–§9.3; PDD §15.1) — the Cooking
 * Academy quiz engine: a versioned question bank, randomized N-of-M selection,
 * per-attempt scoring, and a configurable retake policy whose passing threshold
 * gates certification issuance (TS-255).
 *
 * Two surfaces:
 *   - `QuizAdminController` / `QuizAuthoringService` — the admin authoring of a
 *     `quiz`-kind lesson's bank (quiz config + question/option CRUD), gated on
 *     `academy:read` / `academy:write`. The bank is platform-wide catalog
 *     content (no tenant axis; `unscopedModels`).
 *   - `QuizAttemptController` / `QuizAttemptService` — the student attempt flow
 *     (start → randomized draw + retake enforcement; submit → grade; get / list),
 *     behind `AccessTokenGuard`. Attempt rows are per-student and flow through the
 *     TS-141 gate; the service filters every read/write by `studentUserId`.
 *
 * The load-bearing engine math (selection + scoring + retake policy) lives in the
 * pure `quiz-scoring` / `quiz-retake-policy` modules and is exhaustively
 * unit-tested.
 */
@Module({
  controllers: [QuizAdminController, QuizAttemptController],
  providers: [QuizAuthoringService, QuizAttemptService],
  exports: [QuizAuthoringService, QuizAttemptService],
})
export class QuizModule {}
