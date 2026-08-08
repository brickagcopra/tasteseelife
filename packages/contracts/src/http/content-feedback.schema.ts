import { z } from 'zod';

/**
 * Article feedback ("Was this helpful?") + related-articles HTTP DTOs (TS-287;
 * PRD §10.10, §10.11; PDD §19.3).
 *
 * These are USER-FACING surfaces on `service-content` — any authenticated reader
 * (family / senior / staff) votes on a published article, or asks for related
 * articles. They are NOT admin-permission-gated (no `content:*` permission); the
 * gateway forwards the authenticated actor and service-content keys feedback by
 * the token's `userId`. Distinct from the admin authoring DTOs in
 * `content-article.schema.ts`.
 *
 *   PUT /api/v1/content/articles/:articleId/feedback  — cast / change my vote.
 *   GET /api/v1/content/articles/:articleId/feedback  — aggregate + my vote.
 *   GET /api/v1/content/articles/:articleId/related   — related articles.
 *
 * **One vote per (article, user).** The `PUT` is an UPSERT — re-voting flips
 * `helpful` ↔ `not_helpful` on the same row (enforced by the composite unique in
 * the schema). The response carries the aggregate counts (COMPUTED on read — no
 * denormalised counter) plus the caller's own current rating.
 *
 * **Related articles** are a Phase-2 co-occurrence baseline (shared category /
 * shared authors) behind a strategy seam — an ML ranker drops in later. Each
 * entry is a lightweight article stub + a heuristic `score` (higher = more
 * related).
 *
 * **`.strict()` everywhere** — an unknown field is a 400 (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID-shaped article / feedback row id cap (mirrors the content-author cap). */
export const CONTENT_FEEDBACK_ID_MAX_LENGTH = 36;

/** Related-articles response caps. Bounded, no cursor at Phase-1 volume. */
export const RELATED_ARTICLES_LIMIT_DEFAULT = 5;
export const RELATED_ARTICLES_LIMIT_MAX = 20;

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(CONTENT_FEEDBACK_ID_MAX_LENGTH);
const CountSchema = z.number().int().min(0);
const ScoreSchema = z.number().min(0);

/** The thumbs verdict. Mirrors the `article_feedback_rating` DB enum. */
export const ARTICLE_FEEDBACK_RATINGS = ['helpful', 'not_helpful'] as const;
export const ArticleFeedbackRatingSchema = z.enum(ARTICLE_FEEDBACK_RATINGS);
export type ArticleFeedbackRating = z.infer<typeof ArticleFeedbackRatingSchema>;

// ─── Submit feedback ────────────────────────────────────────────────────

/**
 * `PUT /api/v1/content/articles/:articleId/feedback` body — cast or change the
 * caller's vote. Idempotent UPSERT keyed by (articleId, userId): the same body
 * replayed is a no-op-equivalent write; a different `rating` flips the vote.
 */
export const SubmitArticleFeedbackRequestSchema = z
  .object({
    rating: ArticleFeedbackRatingSchema,
  })
  .strict();
export type SubmitArticleFeedbackRequest = z.infer<typeof SubmitArticleFeedbackRequestSchema>;

// ─── Feedback summary ───────────────────────────────────────────────────

/**
 * The aggregate feedback for an article plus the caller's own vote. Counts are
 * computed on read. `ownRating` is `null` when the caller has not voted.
 */
export const ArticleFeedbackSummarySchema = z
  .object({
    articleId: IdSchema,
    helpfulCount: CountSchema,
    notHelpfulCount: CountSchema,
    ownRating: ArticleFeedbackRatingSchema.nullable(),
  })
  .strict();
export type ArticleFeedbackSummary = z.infer<typeof ArticleFeedbackSummarySchema>;

/** Envelope returned by the feedback PUT + GET. */
export const ArticleFeedbackResponseSchema = z
  .object({ feedback: ArticleFeedbackSummarySchema })
  .strict();
export type ArticleFeedbackResponse = z.infer<typeof ArticleFeedbackResponseSchema>;

// ─── Related articles ───────────────────────────────────────────────────

/** `GET /api/v1/content/articles/:articleId/related` query — bounded by `limit`. */
export const ListRelatedArticlesQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(RELATED_ARTICLES_LIMIT_MAX)
      .default(RELATED_ARTICLES_LIMIT_DEFAULT),
  })
  .strict();
export type ListRelatedArticlesQuery = z.infer<typeof ListRelatedArticlesQuerySchema>;

/**
 * A related-article suggestion — a lightweight published-article stub plus the
 * heuristic relatedness `score` (higher = more related). `score` is
 * strategy-defined (the Phase-2 baseline sums a category-match weight + shared-
 * author overlap); it is NOT normalised to any range.
 */
export const RelatedArticleSchema = z
  .object({
    id: IdSchema,
    slug: z.string().min(1),
    title: z.string().min(1),
    categoryId: IdSchema.nullable(),
    score: ScoreSchema,
  })
  .strict();
export type RelatedArticle = z.infer<typeof RelatedArticleSchema>;

/** `GET …/related` response — the ranked related articles (most related first). */
export const RelatedArticlesResponseSchema = z
  .object({ related: z.array(RelatedArticleSchema) })
  .strict();
export type RelatedArticlesResponse = z.infer<typeof RelatedArticlesResponseSchema>;
