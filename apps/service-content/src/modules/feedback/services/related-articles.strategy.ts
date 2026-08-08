/**
 * Related-articles ranking strategy (TS-287; PDD §19.3). The "slot for ML
 * ranking later" the acceptance calls for: a pure, side-effect-free port that
 * scores candidate articles against a target. The Phase-2 baseline
 * (`CategoryAuthorOverlapStrategy`) ranks by shared category + shared authors;
 * a future ML ranker (or a real co-VIEW co-occurrence model, once a view-event
 * source exists) implements the same interface and drops in at the DI token
 * WITHOUT touching `RelatedArticlesService` or any caller.
 *
 * Genuine co-view co-occurrence is DEFERRED: service-content has no page-view /
 * session signal to co-occur over yet (a carried followup). The category+author
 * heuristic is the available-signal baseline.
 */

/** The article we want suggestions for. */
export interface RelatedTarget {
  readonly id: string;
  readonly categoryId: string | null;
  readonly authorIds: readonly string[];
}

/** A candidate article to score (already filtered to published, self excluded). */
export interface RelatedCandidate {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly categoryId: string | null;
  readonly authorIds: readonly string[];
}

/** A scored suggestion — the candidate stub plus its relatedness score. */
export interface ScoredRelatedArticle {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly categoryId: string | null;
  readonly score: number;
}

/** DI token for the active {@link RelatedArticlesStrategy}. */
export const RELATED_ARTICLES_STRATEGY = Symbol('RELATED_ARTICLES_STRATEGY');

export interface RelatedArticlesStrategy {
  /** A stable identifier for logs / observability (which ranker produced this). */
  readonly name: string;
  /**
   * Rank `candidates` for `target`, returning the top `limit` most-related
   * (highest score first). Candidates that share nothing with the target
   * (score 0) are dropped. Deterministic: ties break by id ascending so the
   * output is stable across calls.
   */
  rank(
    target: RelatedTarget,
    candidates: readonly RelatedCandidate[],
    limit: number,
  ): ScoredRelatedArticle[];
}

/** Weight added when a candidate shares the target's (non-null) category. */
export const CATEGORY_MATCH_WEIGHT = 2;
/** Weight added per author shared with the target. */
export const SHARED_AUTHOR_WEIGHT = 1;

/**
 * Phase-2 baseline: score = (same non-null category ? {@link CATEGORY_MATCH_WEIGHT} : 0)
 * + {@link SHARED_AUTHOR_WEIGHT} × |authors ∩ target.authors|. Score-0 candidates
 * are dropped; the rest sort by score desc, then id asc for determinism.
 */
export class CategoryAuthorOverlapStrategy implements RelatedArticlesStrategy {
  readonly name = 'category-author-overlap-v1';

  rank(
    target: RelatedTarget,
    candidates: readonly RelatedCandidate[],
    limit: number,
  ): ScoredRelatedArticle[] {
    const targetAuthors = new Set(target.authorIds);

    const scored: ScoredRelatedArticle[] = [];
    for (const candidate of candidates) {
      if (candidate.id === target.id) continue;

      let score = 0;
      if (
        target.categoryId !== null &&
        candidate.categoryId !== null &&
        candidate.categoryId === target.categoryId
      ) {
        score += CATEGORY_MATCH_WEIGHT;
      }
      let sharedAuthors = 0;
      for (const authorId of candidate.authorIds) {
        if (targetAuthors.has(authorId)) sharedAuthors += 1;
      }
      score += SHARED_AUTHOR_WEIGHT * sharedAuthors;

      if (score > 0) {
        scored.push({
          id: candidate.id,
          slug: candidate.slug,
          title: candidate.title,
          categoryId: candidate.categoryId,
          score,
        });
      }
    }

    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)));
    return limit >= 0 ? scored.slice(0, limit) : scored;
  }
}
