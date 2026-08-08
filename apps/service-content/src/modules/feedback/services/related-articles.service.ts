import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RelatedArticle } from '@taste-and-see/contracts';

import { ArticleFeedbackRepository } from '../repositories/article-feedback.repository';
import {
  RELATED_ARTICLES_STRATEGY,
  type RelatedArticlesStrategy,
  type RelatedTarget,
} from './related-articles.strategy';

export type RelatedArticlesOutcome =
  | { readonly ok: true; readonly related: readonly RelatedArticle[] }
  | { readonly ok: false; readonly reason: 'not_available' };

/**
 * Related-articles suggestion service (TS-287; PDD §19.3). Loads the target +
 * the candidate pool from the repository and delegates ranking to the injected
 * {@link RelatedArticlesStrategy} (the ML seam) — so swapping the ranker never
 * touches this service or its callers. Only PUBLISHED articles are eligible as a
 * target or a candidate; an unpublished / missing target resolves to
 * `not_available` (404 at the boundary), matching the feedback surface.
 */
@Injectable()
export class RelatedArticlesService {
  private readonly logger = new Logger(RelatedArticlesService.name);

  constructor(
    private readonly repo: ArticleFeedbackRepository,
    @Inject(RELATED_ARTICLES_STRATEGY) private readonly strategy: RelatedArticlesStrategy,
  ) {}

  async getRelated(articleId: string, limit: number): Promise<RelatedArticlesOutcome> {
    const article = await this.repo.findArticle(articleId);
    if (article === null || article.status !== 'published') {
      return { ok: false, reason: 'not_available' };
    }

    const authorIds = await this.repo.findArticleAuthorIds(articleId);
    const target: RelatedTarget = { id: articleId, categoryId: article.categoryId, authorIds };

    const candidates = await this.repo.findRelatedCandidates(articleId);
    const related = this.strategy.rank(target, candidates, limit);

    this.logger.log(
      {
        articleId,
        strategy: this.strategy.name,
        candidateCount: candidates.length,
        resultCount: related.length,
      },
      'related articles computed',
    );

    return { ok: true, related };
  }
}
