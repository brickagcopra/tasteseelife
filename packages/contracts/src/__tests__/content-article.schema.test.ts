import { describe, expect, it } from 'vitest';

import {
  CONTENT_ARTICLES_LIST_LIMIT_DEFAULT,
  CONTENT_ARTICLES_LIST_LIMIT_MAX,
  CONTENT_ARTICLE_BODY_MAX_LENGTH,
  CONTENT_ARTICLE_SLUG_MAX_LENGTH,
  CONTENT_ARTICLE_TITLE_MAX_LENGTH,
  CONTENT_DISQUS_IDENTIFIER_MAX_LENGTH,
  CONTENT_SEO_JSON_LD_MAX_BYTES,
  ArticleCommentsSchema,
  ArticleDetailSchema,
  ArticleRecordSchema,
  ArticleSeoSchema,
  ArticleVersionRecordSchema,
  CreateArticleRequestSchema,
  CreateArticleVersionRequestSchema,
  ListArticlesQuerySchema,
  PublishArticleVersionRequestSchema,
  UpdateArticleCommentsRequestSchema,
  UpdateArticleRequestSchema,
  UpdateArticleSeoRequestSchema,
} from '../http/content-article.schema';

const ISO = '2026-06-30T00:00:00.000Z';

const DEFAULT_COMMENTS = {
  enabled: false,
  provider: 'disqus' as const,
  disqusIdentifier: null,
};

const NULL_SEO = {
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

describe('CreateArticleRequestSchema', () => {
  it('accepts a lowercase kebab-case slug + title, categoryId optional', () => {
    const parsed = CreateArticleRequestSchema.parse({ slug: 'welcome-post', title: 'Welcome' });
    expect(parsed.slug).toBe('welcome-post');
    expect(parsed.categoryId).toBeUndefined();
  });

  it('accepts an optional categoryId', () => {
    const parsed = CreateArticleRequestSchema.parse({
      slug: 'x',
      title: 'X',
      categoryId: 'cat_1',
    });
    expect(parsed.categoryId).toBe('cat_1');
  });

  it('rejects an upper-case / spaced / underscored slug', () => {
    expect(CreateArticleRequestSchema.safeParse({ slug: 'Welcome Post', title: 'x' }).success).toBe(
      false,
    );
    expect(CreateArticleRequestSchema.safeParse({ slug: 'welcome_post', title: 'x' }).success).toBe(
      false,
    );
    expect(CreateArticleRequestSchema.safeParse({ slug: '-leading', title: 'x' }).success).toBe(
      false,
    );
  });

  it('trims and rejects a blank title', () => {
    expect(CreateArticleRequestSchema.safeParse({ slug: 'ok', title: '   ' }).success).toBe(false);
  });

  it('rejects an over-long slug / title', () => {
    expect(
      CreateArticleRequestSchema.safeParse({
        slug: 'a'.repeat(CONTENT_ARTICLE_SLUG_MAX_LENGTH + 1),
        title: 'x',
      }).success,
    ).toBe(false);
    expect(
      CreateArticleRequestSchema.safeParse({
        slug: 'ok',
        title: 'a'.repeat(CONTENT_ARTICLE_TITLE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    expect(
      CreateArticleRequestSchema.safeParse({ slug: 'ok', title: 'X', status: 'published' }).success,
    ).toBe(false);
  });
});

describe('UpdateArticleRequestSchema', () => {
  it('accepts a title-only update', () => {
    expect(UpdateArticleRequestSchema.parse({ title: 'New Title' }).title).toBe('New Title');
  });

  it('accepts a categoryId re-assignment and an explicit null clear', () => {
    expect(UpdateArticleRequestSchema.parse({ categoryId: 'cat_2' }).categoryId).toBe('cat_2');
    expect(UpdateArticleRequestSchema.parse({ categoryId: null }).categoryId).toBeNull();
  });

  it('rejects an empty body (at least one field required)', () => {
    expect(UpdateArticleRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    expect(UpdateArticleRequestSchema.safeParse({ slug: 'renamed' }).success).toBe(false);
  });
});

describe('CreateArticleVersionRequestSchema', () => {
  it('accepts a title + body', () => {
    const parsed = CreateArticleVersionRequestSchema.parse({ title: 'v1', body: 'hello' });
    expect(parsed.body).toBe('hello');
  });

  it('rejects a blank body and an over-long body', () => {
    expect(CreateArticleVersionRequestSchema.safeParse({ title: 'v', body: '' }).success).toBe(
      false,
    );
    expect(
      CreateArticleVersionRequestSchema.safeParse({
        title: 'v',
        body: 'a'.repeat(CONTENT_ARTICLE_BODY_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects an effectiveAt in the append body (publish stamps it)', () => {
    expect(
      CreateArticleVersionRequestSchema.safeParse({ title: 'v', body: 'b', effectiveAt: ISO })
        .success,
    ).toBe(false);
  });
});

describe('PublishArticleVersionRequestSchema', () => {
  it('accepts an empty body (effective now)', () => {
    expect(PublishArticleVersionRequestSchema.parse({}).effectiveAt).toBeUndefined();
  });

  it('accepts an explicit ISO effectiveAt', () => {
    expect(PublishArticleVersionRequestSchema.parse({ effectiveAt: ISO }).effectiveAt).toBe(ISO);
  });

  it('rejects a non-ISO effectiveAt and unknown fields', () => {
    expect(PublishArticleVersionRequestSchema.safeParse({ effectiveAt: 'soon' }).success).toBe(
      false,
    );
    expect(PublishArticleVersionRequestSchema.safeParse({ foo: 1 }).success).toBe(false);
  });
});

describe('ListArticlesQuerySchema', () => {
  it('defaults the limit and coerces a string limit', () => {
    expect(ListArticlesQuerySchema.parse({}).limit).toBe(CONTENT_ARTICLES_LIST_LIMIT_DEFAULT);
    expect(ListArticlesQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  it('accepts status + categoryId filters', () => {
    const parsed = ListArticlesQuerySchema.parse({ status: 'published', categoryId: 'cat_1' });
    expect(parsed.status).toBe('published');
    expect(parsed.categoryId).toBe('cat_1');
  });

  it('rejects a limit over the max', () => {
    expect(
      ListArticlesQuerySchema.safeParse({ limit: CONTENT_ARTICLES_LIST_LIMIT_MAX + 1 }).success,
    ).toBe(false);
  });
});

describe('record shapes', () => {
  const version = {
    id: 'ver_1',
    articleId: 'art_1',
    versionNo: 1,
    title: 'v1',
    body: 'body',
    effectiveAt: null,
    createdBy: 'user_1',
    createdAt: ISO,
    updatedAt: ISO,
  };
  const article = {
    id: 'art_1',
    slug: 'welcome',
    status: 'draft' as const,
    title: 'Welcome',
    categoryId: null,
    currentVersionId: null,
    newsletterSentAt: null,
    createdAt: ISO,
    updatedAt: ISO,
  };

  it('parses a version record', () => {
    expect(ArticleVersionRecordSchema.parse(version).versionNo).toBe(1);
  });

  it('parses a shallow article record', () => {
    expect(ArticleRecordSchema.parse(article).slug).toBe('welcome');
  });

  it('parses an article-detail record with nested versions + SEO + comments blocks', () => {
    const detail = ArticleDetailSchema.parse({
      ...article,
      versions: [version],
      seo: NULL_SEO,
      comments: DEFAULT_COMMENTS,
    });
    expect(detail.versions).toHaveLength(1);
    expect(detail.seo.seoTitle).toBeNull();
    expect(detail.comments.enabled).toBe(false);
  });

  it('rejects an article-detail record missing the SEO block', () => {
    expect(
      ArticleDetailSchema.safeParse({ ...article, versions: [version], comments: DEFAULT_COMMENTS })
        .success,
    ).toBe(false);
  });

  it('rejects an article-detail record missing the comments block', () => {
    expect(
      ArticleDetailSchema.safeParse({ ...article, versions: [version], seo: NULL_SEO }).success,
    ).toBe(false);
  });

  it('rejects an unknown field on a record (.strict)', () => {
    expect(ArticleRecordSchema.safeParse({ ...article, extra: true }).success).toBe(false);
  });
});

describe('ArticleSeoSchema', () => {
  it('parses an all-null SEO block', () => {
    expect(ArticleSeoSchema.parse(NULL_SEO).canonicalUrl).toBeNull();
  });

  it('accepts a populated block incl. a JSON-LD object', () => {
    const parsed = ArticleSeoSchema.parse({
      ...NULL_SEO,
      seoTitle: 'Best pie',
      canonicalUrl: 'https://tasteandsee.example/blog/pie',
      twitterCard: 'summary_large_image',
      jsonLd: { '@context': 'https://schema.org', '@type': 'Article' },
    });
    expect(parsed.twitterCard).toBe('summary_large_image');
    expect(parsed.jsonLd).toEqual({ '@context': 'https://schema.org', '@type': 'Article' });
  });

  it('rejects a non-http canonical URL', () => {
    expect(ArticleSeoSchema.safeParse({ ...NULL_SEO, canonicalUrl: 'not-a-url' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown twitterCard value', () => {
    expect(ArticleSeoSchema.safeParse({ ...NULL_SEO, twitterCard: 'app' }).success).toBe(false);
  });

  it('rejects a JSON-LD array (must be an object)', () => {
    expect(ArticleSeoSchema.safeParse({ ...NULL_SEO, jsonLd: [1, 2, 3] }).success).toBe(false);
  });

  it('rejects a JSON-LD blob over the byte cap', () => {
    const huge = { blob: 'x'.repeat(CONTENT_SEO_JSON_LD_MAX_BYTES + 10) };
    expect(ArticleSeoSchema.safeParse({ ...NULL_SEO, jsonLd: huge }).success).toBe(false);
  });
});

describe('UpdateArticleSeoRequestSchema', () => {
  it('accepts a partial update', () => {
    const parsed = UpdateArticleSeoRequestSchema.parse({ seoTitle: 'T' });
    expect(parsed.seoTitle).toBe('T');
  });

  it('accepts an explicit null to clear a field', () => {
    const parsed = UpdateArticleSeoRequestSchema.parse({ metaDescription: null });
    expect(parsed.metaDescription).toBeNull();
  });

  it('rejects an empty body (at least one field required)', () => {
    expect(UpdateArticleSeoRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown field (.strict)', () => {
    expect(UpdateArticleSeoRequestSchema.safeParse({ foo: 'bar' }).success).toBe(false);
  });
});

describe('ArticleCommentsSchema', () => {
  it('parses the default (comments off, Disqus, no identifier) block', () => {
    const parsed = ArticleCommentsSchema.parse(DEFAULT_COMMENTS);
    expect(parsed.enabled).toBe(false);
    expect(parsed.provider).toBe('disqus');
    expect(parsed.disqusIdentifier).toBeNull();
  });

  it('rejects an unknown provider and an unknown field (.strict)', () => {
    expect(
      ArticleCommentsSchema.safeParse({ ...DEFAULT_COMMENTS, provider: 'facebook' }).success,
    ).toBe(false);
    expect(ArticleCommentsSchema.safeParse({ ...DEFAULT_COMMENTS, extra: true }).success).toBe(
      false,
    );
  });
});

describe('UpdateArticleCommentsRequestSchema', () => {
  it('accepts a partial update (toggle only)', () => {
    const parsed = UpdateArticleCommentsRequestSchema.parse({ enabled: true });
    expect(parsed.enabled).toBe(true);
    expect(parsed.provider).toBeUndefined();
  });

  it('accepts an explicit null to clear the identifier and trims a set one', () => {
    expect(
      UpdateArticleCommentsRequestSchema.parse({ disqusIdentifier: null }).disqusIdentifier,
    ).toBeNull();
    expect(
      UpdateArticleCommentsRequestSchema.parse({ disqusIdentifier: '  thread-1  ' })
        .disqusIdentifier,
    ).toBe('thread-1');
  });

  it('rejects an over-length identifier', () => {
    expect(
      UpdateArticleCommentsRequestSchema.safeParse({
        disqusIdentifier: 'x'.repeat(CONTENT_DISQUS_IDENTIFIER_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects an empty body (at least one field required)', () => {
    expect(UpdateArticleCommentsRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown provider and an unknown field (.strict)', () => {
    expect(UpdateArticleCommentsRequestSchema.safeParse({ provider: 'facebook' }).success).toBe(
      false,
    );
    expect(UpdateArticleCommentsRequestSchema.safeParse({ foo: 'bar' }).success).toBe(false);
  });
});
