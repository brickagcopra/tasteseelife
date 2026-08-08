import { describe, expect, it } from 'vitest';

import {
  ListPublicBlogArticlesQuerySchema,
  PUBLIC_BLOG_PAGE_MAX,
  PublicBlogArticleListItemSchema,
  PublicBlogArticleResponseSchema,
  PublicBlogArticleSchema,
  PublicBlogArticlesListResponseSchema,
} from '../http/content-public-blog.schema';

/**
 * Public blog read contracts (TS-282-followup-3). The load-bearing property is
 * that these are `.strict()` STRICT SUBSETS of the admin shapes — an internal
 * field riding a downstream body must FAIL the parse (the gateway's
 * drift-to-502 line of defense), never pass through to the public payload.
 */

const VALID_SEO = {
  seoTitle: null,
  metaDescription: null,
  canonicalUrl: null,
  ogTitle: null,
  ogDescription: null,
  ogImageKey: null,
  twitterCard: null,
  twitterTitle: null,
  twitterDescription: null,
  twitterImageKey: null,
  jsonLd: null,
};

const VALID_ARTICLE = {
  slug: 'a-table-set-with-care',
  title: 'A table set with care',
  body: '## Welcome\n\nOur first story.',
  publishedAt: '2026-07-02T12:00:00.000Z',
  category: { slug: 'stories', name: 'Stories' },
  seo: VALID_SEO,
  authors: [
    {
      displayName: 'Chef Maria Alvarez',
      role: 'primary',
      bio: 'Head chef and storyteller.',
      photoAssetKey: null,
      socialLinks: { website: 'https://example.com' },
    },
  ],
  comments: null,
};

const VALID_LIST_ITEM = {
  slug: 'a-table-set-with-care',
  title: 'A table set with care',
  publishedAt: '2026-07-02T12:00:00.000Z',
  metaDescription: 'Our first story.',
  category: { slug: 'stories', name: 'Stories' },
  primaryAuthor: { displayName: 'Chef Maria Alvarez', photoAssetKey: null },
};

describe('PublicBlogArticleSchema', () => {
  it('accepts a fully-populated published article', () => {
    expect(PublicBlogArticleSchema.parse(VALID_ARTICLE)).toEqual(VALID_ARTICLE);
  });

  it('accepts an uncategorised, uncredited, comments-dark article', () => {
    const minimal = { ...VALID_ARTICLE, category: null, authors: [], comments: null };
    expect(PublicBlogArticleSchema.parse(minimal).authors).toEqual([]);
  });

  it('accepts an enabled comments config with a null identifier (slug fallback)', () => {
    const withComments = {
      ...VALID_ARTICLE,
      comments: { provider: 'disqus', disqusIdentifier: null },
    };
    expect(PublicBlogArticleSchema.parse(withComments).comments).toEqual({
      provider: 'disqus',
      disqusIdentifier: null,
    });
  });

  it.each([
    ['status', 'published'],
    ['createdBy', 'usr_staff'],
    ['currentVersionId', 'ver_1'],
    ['newsletterSentAt', '2026-07-01T00:00:00.000Z'],
    ['id', 'art_1'],
  ])('REJECTS an internal admin field leaking onto the article: %s', (key, value) => {
    expect(PublicBlogArticleSchema.safeParse({ ...VALID_ARTICLE, [key]: value }).success).toBe(
      false,
    );
  });

  it('REJECTS an author carrying the internal userId reference', () => {
    const leaking = {
      ...VALID_ARTICLE,
      authors: [{ ...VALID_ARTICLE.authors[0], userId: 'usr_1' }],
    };
    expect(PublicBlogArticleSchema.safeParse(leaking).success).toBe(false);
  });
});

describe('PublicBlogArticleListItemSchema', () => {
  it('accepts a card item and rejects a body riding the list', () => {
    expect(PublicBlogArticleListItemSchema.parse(VALID_LIST_ITEM)).toEqual(VALID_LIST_ITEM);
    expect(
      PublicBlogArticleListItemSchema.safeParse({ ...VALID_LIST_ITEM, body: '# nope' }).success,
    ).toBe(false);
  });
});

describe('ListPublicBlogArticlesQuerySchema', () => {
  it('defaults page to 1 and coerces the string query value', () => {
    expect(ListPublicBlogArticlesQuerySchema.parse({})).toEqual({ page: 1 });
    expect(ListPublicBlogArticlesQuerySchema.parse({ page: '3' }).page).toBe(3);
  });

  it('bounds hostile page numbers and rejects a malformed category slug', () => {
    expect(
      ListPublicBlogArticlesQuerySchema.safeParse({ page: PUBLIC_BLOG_PAGE_MAX + 1 }).success,
    ).toBe(false);
    expect(ListPublicBlogArticlesQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(ListPublicBlogArticlesQuerySchema.safeParse({ category: 'Not A Slug' }).success).toBe(
      false,
    );
  });
});

describe('PublicBlogArticlesListResponseSchema / PublicBlogArticleResponseSchema', () => {
  it('accepts the index envelope with paging facts + in-use categories', () => {
    const envelope = {
      articles: [VALID_LIST_ITEM],
      page: 1,
      pageSize: 12,
      totalArticles: 1,
      totalPages: 1,
      categories: [{ slug: 'stories', name: 'Stories' }],
    };
    expect(PublicBlogArticlesListResponseSchema.parse(envelope)).toEqual(envelope);
  });

  it('accepts the detail envelope and rejects unknown envelope keys', () => {
    expect(PublicBlogArticleResponseSchema.parse({ article: VALID_ARTICLE }).article.slug).toBe(
      VALID_ARTICLE.slug,
    );
    expect(
      PublicBlogArticleResponseSchema.safeParse({ article: VALID_ARTICLE, versions: [] }).success,
    ).toBe(false);
  });
});
