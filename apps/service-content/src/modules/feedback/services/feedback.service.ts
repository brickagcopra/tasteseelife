import { Injectable, Logger } from '@nestjs/common';
import type { ArticleFeedbackRating, ArticleFeedbackSummary } from '@taste-and-see/contracts';

import { ArticleFeedbackRepository } from '../repositories/article-feedback.repository';

export interface SubmitFeedbackInput {
  readonly articleId: string;
  readonly userId: string;
  readonly rating: ArticleFeedbackRating;
}

export type FeedbackOutcome =
  | { readonly ok: true; readonly summary: ArticleFeedbackSummary }
  | { readonly ok: false; readonly reason: 'not_available' };

/**
 * End-user "Was this helpful?" feedback (TS-287; PDD §19.3).
 *
 * Feedback is only accepted / reported on PUBLISHED articles — a draft/archived
 * article is not publicly served, so a `draft`, `archived`, or missing article
 * all resolve to a single `not_available` outcome (mapped to 404 at the
 * boundary) so the surface never leaks the existence of unpublished drafts to
 * end users.
 *
 * This is user telemetry, NOT an admin mutation — it is deliberately NOT
 * audit-logged per vote (CLAUDE.md §3.6 audit is for admin mutations; a per-vote
 * audit row would flood the append-only log). Each vote logs at info for
 * observability (CLAUDE.md §10).
 */
@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(private readonly repo: ArticleFeedbackRepository) {}

  /** UPSERT the caller's vote, then return the fresh aggregate + own rating. */
  async submit(input: SubmitFeedbackInput): Promise<FeedbackOutcome> {
    const article = await this.repo.findArticle(input.articleId);
    if (article === null || article.status !== 'published') {
      return { ok: false, reason: 'not_available' };
    }

    await this.repo.upsertVote(input.articleId, input.userId, input.rating);

    this.logger.log(
      { articleId: input.articleId, userId: input.userId, rating: input.rating },
      'article feedback recorded',
    );

    return { ok: true, summary: await this.summarise(input.articleId, input.userId) };
  }

  /** The aggregate feedback for an article plus the caller's own vote. */
  async getSummary(articleId: string, userId: string): Promise<FeedbackOutcome> {
    const article = await this.repo.findArticle(articleId);
    if (article === null || article.status !== 'published') {
      return { ok: false, reason: 'not_available' };
    }
    return { ok: true, summary: await this.summarise(articleId, userId) };
  }

  private async summarise(articleId: string, userId: string): Promise<ArticleFeedbackSummary> {
    const [counts, ownRating] = await Promise.all([
      this.repo.countByRating(articleId),
      this.repo.findOwnRating(articleId, userId),
    ]);
    return {
      articleId,
      helpfulCount: counts.helpfulCount,
      notHelpfulCount: counts.notHelpfulCount,
      ownRating,
    };
  }
}
