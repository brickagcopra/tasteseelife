import { describe, expect, it } from 'vitest';

import {
  CONTENT_ARTICLE_PUBLISHED,
  CONTENT_ARTICLE_UNPUBLISHED,
  CONTENT_SEARCH_EVENT_AUTHOR_IDS_MAX,
  CONTENT_SEARCH_EVENT_EXCERPT_MAX_LENGTH,
  ContentArticlePublishedSchema,
  ContentArticleUnpublishedSchema,
  eventRegistry,
  getEventSchema,
} from '../events';

/**
 * Contract tests for the content search-indexing events (TS-286).
 *
 * Pins the wire shape (`.strict()`), the envelope, the bounded projection
 * fields, and the registry wiring — so a producer edit is a parse error and the
 * (carved) `worker-search-indexer` consumer (TS-286-followup-1) can map the
 * payload 1:1 into the `articles` ES doc.
 */
describe('content search-indexing event registry wiring', () => {
  it('registers both events under their dotted constants', () => {
    expect(eventRegistry[CONTENT_ARTICLE_PUBLISHED]).toBe(ContentArticlePublishedSchema);
    expect(eventRegistry[CONTENT_ARTICLE_UNPUBLISHED]).toBe(ContentArticleUnpublishedSchema);
    expect(getEventSchema(CONTENT_ARTICLE_PUBLISHED)).toBe(ContentArticlePublishedSchema);
    expect(getEventSchema(CONTENT_ARTICLE_UNPUBLISHED)).toBe(ContentArticleUnpublishedSchema);
  });

  it('uses past-tense dotted names', () => {
    expect(CONTENT_ARTICLE_PUBLISHED).toBe('content.article.published');
    expect(CONTENT_ARTICLE_UNPUBLISHED).toBe('content.article.unpublished');
    for (const name of [CONTENT_ARTICLE_PUBLISHED, CONTENT_ARTICLE_UNPUBLISHED]) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });
});

describe('ContentArticlePublished event', () => {
  const valid = {
    eventId: 'evt_1',
    occurredAt: '2026-06-30T12:00:00.000Z',
    articleId: 'art_1',
    slug: 'welcome-to-taste-and-see',
    title: 'Welcome to Taste & See',
    excerpt: 'A short lead paragraph.',
    body: '# Welcome\n\nSome **markdown** body.',
    categoryId: 'cat_1',
    authorIds: ['author_1', 'author_2'],
    seoTitle: 'Welcome | Taste & See',
    metaDescription: 'Get started with Taste & See.',
    publishedAt: '2026-07-01T00:00:00.000Z',
    versionNo: 2,
  };

  it('accepts a valid payload', () => {
    expect(ContentArticlePublishedSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts nullable projection fields as null + an empty byline', () => {
    expect(
      ContentArticlePublishedSchema.safeParse({
        ...valid,
        excerpt: null,
        categoryId: null,
        authorIds: [],
        seoTitle: null,
        metaDescription: null,
      }).success,
    ).toBe(true);
  });

  it('accepts an empty body (empty article draft published)', () => {
    expect(ContentArticlePublishedSchema.safeParse({ ...valid, body: '' }).success).toBe(true);
  });

  it('rejects an unknown field (.strict)', () => {
    expect(ContentArticlePublishedSchema.safeParse({ ...valid, extra: 'nope' }).success).toBe(
      false,
    );
  });

  it('rejects a non-positive versionNo', () => {
    expect(ContentArticlePublishedSchema.safeParse({ ...valid, versionNo: 0 }).success).toBe(false);
  });

  it('rejects an excerpt over the cap', () => {
    expect(
      ContentArticlePublishedSchema.safeParse({
        ...valid,
        excerpt: 'x'.repeat(CONTENT_SEARCH_EVENT_EXCERPT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects more author ids than the byline cap', () => {
    expect(
      ContentArticlePublishedSchema.safeParse({
        ...valid,
        authorIds: Array.from(
          { length: CONTENT_SEARCH_EVENT_AUTHOR_IDS_MAX + 1 },
          (_unused, i) => `author_${i}`,
        ),
      }).success,
    ).toBe(false);
  });

  it('rejects a non-datetime publishedAt', () => {
    expect(ContentArticlePublishedSchema.safeParse({ ...valid, publishedAt: 'soon' }).success).toBe(
      false,
    );
  });
});

describe('ContentArticleUnpublished event', () => {
  const valid = {
    eventId: 'evt_2',
    occurredAt: '2026-06-30T12:00:00.000Z',
    articleId: 'art_1',
    slug: 'welcome-to-taste-and-see',
  };

  it('accepts a valid tombstone payload', () => {
    expect(ContentArticleUnpublishedSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an unknown field (.strict)', () => {
    expect(ContentArticleUnpublishedSchema.safeParse({ ...valid, extra: 'nope' }).success).toBe(
      false,
    );
  });

  it('rejects a missing slug', () => {
    const { slug: _slug, ...withoutSlug } = valid;
    expect(ContentArticleUnpublishedSchema.safeParse(withoutSlug).success).toBe(false);
  });
});
