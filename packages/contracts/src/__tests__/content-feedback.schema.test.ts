import { describe, expect, it } from 'vitest';

import {
  ArticleFeedbackResponseSchema,
  ArticleFeedbackSummarySchema,
  ListRelatedArticlesQuerySchema,
  RELATED_ARTICLES_LIMIT_DEFAULT,
  RELATED_ARTICLES_LIMIT_MAX,
  RelatedArticleSchema,
  RelatedArticlesResponseSchema,
  SubmitArticleFeedbackRequestSchema,
} from '../http/content-feedback.schema';

describe('SubmitArticleFeedbackRequestSchema', () => {
  it('accepts a valid rating', () => {
    expect(SubmitArticleFeedbackRequestSchema.parse({ rating: 'helpful' })).toEqual({
      rating: 'helpful',
    });
    expect(SubmitArticleFeedbackRequestSchema.parse({ rating: 'not_helpful' })).toEqual({
      rating: 'not_helpful',
    });
  });

  it('rejects an unknown rating', () => {
    expect(SubmitArticleFeedbackRequestSchema.safeParse({ rating: 'meh' }).success).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    expect(
      SubmitArticleFeedbackRequestSchema.safeParse({ rating: 'helpful', extra: 1 }).success,
    ).toBe(false);
  });

  it('requires the rating', () => {
    expect(SubmitArticleFeedbackRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('ArticleFeedbackSummarySchema', () => {
  it('accepts a valid summary with a null ownRating', () => {
    const parsed = ArticleFeedbackSummarySchema.parse({
      articleId: 'art_1',
      helpfulCount: 3,
      notHelpfulCount: 1,
      ownRating: null,
    });
    expect(parsed.ownRating).toBeNull();
  });

  it('rejects negative counts', () => {
    expect(
      ArticleFeedbackSummarySchema.safeParse({
        articleId: 'art_1',
        helpfulCount: -1,
        notHelpfulCount: 0,
        ownRating: null,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-integer count', () => {
    expect(
      ArticleFeedbackSummarySchema.safeParse({
        articleId: 'art_1',
        helpfulCount: 1.5,
        notHelpfulCount: 0,
        ownRating: null,
      }).success,
    ).toBe(false);
  });
});

describe('ArticleFeedbackResponseSchema', () => {
  it('wraps a summary', () => {
    const parsed = ArticleFeedbackResponseSchema.parse({
      feedback: { articleId: 'art_1', helpfulCount: 0, notHelpfulCount: 0, ownRating: 'helpful' },
    });
    expect(parsed.feedback.ownRating).toBe('helpful');
  });
});

describe('ListRelatedArticlesQuerySchema', () => {
  it('defaults the limit', () => {
    expect(ListRelatedArticlesQuerySchema.parse({}).limit).toBe(RELATED_ARTICLES_LIMIT_DEFAULT);
  });

  it('coerces a string limit', () => {
    expect(ListRelatedArticlesQuerySchema.parse({ limit: '7' }).limit).toBe(7);
  });

  it('rejects a limit over the max', () => {
    expect(
      ListRelatedArticlesQuerySchema.safeParse({ limit: RELATED_ARTICLES_LIMIT_MAX + 1 }).success,
    ).toBe(false);
  });

  it('rejects a zero / negative limit', () => {
    expect(ListRelatedArticlesQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe('RelatedArticleSchema', () => {
  it('accepts a valid related-article stub', () => {
    const parsed = RelatedArticleSchema.parse({
      id: 'art_2',
      slug: 'sibling',
      title: 'Sibling',
      categoryId: 'cat_1',
      score: 2,
    });
    expect(parsed.score).toBe(2);
  });

  it('accepts a null categoryId', () => {
    expect(
      RelatedArticleSchema.safeParse({ id: 'a', slug: 's', title: 't', categoryId: null, score: 0 })
        .success,
    ).toBe(true);
  });

  it('rejects a negative score', () => {
    expect(
      RelatedArticleSchema.safeParse({
        id: 'a',
        slug: 's',
        title: 't',
        categoryId: null,
        score: -1,
      }).success,
    ).toBe(false);
  });
});

describe('RelatedArticlesResponseSchema', () => {
  it('wraps a related-articles array', () => {
    const parsed = RelatedArticlesResponseSchema.parse({
      related: [{ id: 'art_2', slug: 'sibling', title: 'Sibling', categoryId: null, score: 1 }],
    });
    expect(parsed.related).toHaveLength(1);
  });

  it('accepts an empty array', () => {
    expect(RelatedArticlesResponseSchema.parse({ related: [] }).related).toEqual([]);
  });
});
