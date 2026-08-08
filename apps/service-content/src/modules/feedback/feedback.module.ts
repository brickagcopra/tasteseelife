import { Module } from '@nestjs/common';

import { FeedbackController } from './controllers/feedback.controller';
import { ArticleFeedbackRepository } from './repositories/article-feedback.repository';
import { FeedbackService } from './services/feedback.service';
import { RelatedArticlesService } from './services/related-articles.service';
import {
  CategoryAuthorOverlapStrategy,
  RELATED_ARTICLES_STRATEGY,
} from './services/related-articles.strategy';

/**
 * End-user article-engagement module (TS-287; PRD §10.10, §10.11; PDD §19.3) —
 * "Was this helpful?" feedback + related-article suggestions.
 *
 * Composition:
 *   - `FeedbackController` — the authenticated-user surface (feedback PUT/GET +
 *     related GET), behind `AccessTokenGuard` only (no permission gate; the vote
 *     is keyed by the token `userId`). Uses the globally-wired `NestAuthModule` +
 *     `IdempotencyModule` (from `app.module.ts`).
 *   - `FeedbackService` — vote UPSERT + published-only gate + aggregate summary.
 *   - `RelatedArticlesService` — target/candidate load + ranking delegation.
 *   - `ArticleFeedbackRepository` — persistence + computed count-by-rating.
 *   - `RELATED_ARTICLES_STRATEGY` — bound to `CategoryAuthorOverlapStrategy` (the
 *     Phase-2 baseline); an ML ranker replaces this binding without touching any
 *     caller.
 *
 * No `AuditModule` — feedback is user telemetry, not an admin mutation, so it is
 * deliberately not audit-logged per vote (CLAUDE.md §3.6).
 */
@Module({
  controllers: [FeedbackController],
  providers: [
    FeedbackService,
    RelatedArticlesService,
    ArticleFeedbackRepository,
    { provide: RELATED_ARTICLES_STRATEGY, useClass: CategoryAuthorOverlapStrategy },
  ],
})
export class FeedbackModule {}
