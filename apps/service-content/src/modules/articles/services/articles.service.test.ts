import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AuditActorContext } from '@taste-and-see/nest-audit';
import type { AuditEmitter } from '@taste-and-see/nest-audit';
import type { ContentNewsletterEmitter } from '../../audit/content-newsletter-emitter';
import type { ContentSearchEmitter } from '../../audit/content-search-emitter';
import { ArticleRepository } from '../repositories/article.repository';
import { ArticlesService } from './articles.service';
import { FakeArticlePrisma } from './__fixtures__/fake-prisma';

function actor(): AuditActorContext {
  return {
    actorUserId: 'user_admin',
    actorRole: 'super_admin',
    actorTenantScopeType: 'global',
    actorTenantScopeId: null,
    ip: '203.0.113.5',
    userAgent: 'vitest',
    requestId: 'req_1',
    traceId: null,
  };
}

interface Harness {
  service: ArticlesService;
  prisma: FakeArticlePrisma;
  emit: ReturnType<typeof vi.fn>;
  emitPublished: ReturnType<typeof vi.fn>;
  emitNewsletter: ReturnType<typeof vi.fn>;
}

function build(): Harness {
  const prisma = new FakeArticlePrisma();
  const repo = new ArticleRepository(prisma as never);
  const emit = vi.fn().mockResolvedValue(undefined);
  const audit = { emit } as unknown as AuditEmitter;
  const emitPublished = vi.fn().mockResolvedValue(undefined);
  const search = { emitPublished } as unknown as ContentSearchEmitter;
  const emitNewsletter = vi.fn().mockResolvedValue(undefined);
  const newsletter = { emit: emitNewsletter } as unknown as ContentNewsletterEmitter;
  const service = new ArticlesService(repo, audit, search, newsletter);
  return { service, prisma, emit, emitPublished, emitNewsletter };
}

let h: Harness;
beforeEach(() => {
  h = build();
});

describe('createArticle', () => {
  it('creates a draft article and emits content_article:create in-tx', async () => {
    const outcome = await h.service.createArticle({
      slug: 'welcome',
      title: 'Welcome',
      actorUserId: 'user_admin',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.article.slug).toBe('welcome');
    expect(outcome.article.status).toBe('draft');
    expect(outcome.article.categoryId).toBeNull();
    expect(outcome.article.currentVersionId).toBeNull();
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({
      action: 'content_article:create',
      resourceKind: 'content_article',
    });
    expect(h.emit.mock.calls[0]?.[0]).toBe(h.prisma);
  });

  it('accepts a valid categoryId', async () => {
    h.prisma.seedCategory('cat_1');
    const outcome = await h.service.createArticle({
      slug: 'billing-faq',
      title: 'Billing FAQ',
      categoryId: 'cat_1',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome.ok && outcome.article.categoryId).toBe('cat_1');
  });

  it('rejects an unknown categoryId with category_not_found and does not audit', async () => {
    const outcome = await h.service.createArticle({
      slug: 'x',
      title: 'X',
      categoryId: 'missing',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'category_not_found' });
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.prisma.articles).toHaveLength(0);
  });

  it('rejects a duplicate slug with slug_conflict and does not audit', async () => {
    await h.service.createArticle({ slug: 'dupe', title: 'A', actorUserId: 'u', audit: actor() });
    h.emit.mockClear();

    const outcome = await h.service.createArticle({
      slug: 'dupe',
      title: 'B',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'slug_conflict' });
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.prisma.articles).toHaveLength(1);
  });
});

describe('updateArticle', () => {
  it('updates title + category and emits content_article:update', async () => {
    h.prisma.seedCategory('cat_1');
    const created = await h.service.createArticle({
      slug: 'a',
      title: 'A',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!created.ok) throw new Error('precondition');
    h.emit.mockClear();

    const outcome = await h.service.updateArticle({
      articleId: created.article.id,
      title: 'A2',
      categoryId: 'cat_1',
      actorUserId: 'u',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.article.title).toBe('A2');
    expect(outcome.article.categoryId).toBe('cat_1');
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({ action: 'content_article:update' });
  });

  it('clears the category with an explicit null', async () => {
    h.prisma.seedCategory('cat_1');
    const created = await h.service.createArticle({
      slug: 'a',
      title: 'A',
      categoryId: 'cat_1',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!created.ok) throw new Error('precondition');

    const outcome = await h.service.updateArticle({
      articleId: created.article.id,
      categoryId: null,
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome.ok && outcome.article.categoryId).toBeNull();
  });

  it('returns article_not_found for an unknown article', async () => {
    const outcome = await h.service.updateArticle({
      articleId: 'missing',
      title: 'x',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'article_not_found' });
  });

  it('returns category_not_found for an unknown new category', async () => {
    const created = await h.service.createArticle({
      slug: 'a',
      title: 'A',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!created.ok) throw new Error('precondition');
    const outcome = await h.service.updateArticle({
      articleId: created.article.id,
      categoryId: 'missing',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'category_not_found' });
  });
});

describe('updateSeo', () => {
  async function seedArticle(): Promise<string> {
    const created = await h.service.createArticle({
      slug: 'a',
      title: 'A',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!created.ok) throw new Error('precondition');
    return created.article.id;
  }

  it('writes SEO fields + JSON-LD and emits content_article:seo_updated in-tx with an all-null before', async () => {
    const articleId = await seedArticle();
    h.emit.mockClear();

    const outcome = await h.service.updateSeo({
      articleId,
      seoTitle: 'Best pie',
      metaDescription: 'A pie guide',
      canonicalUrl: 'https://tasteandsee.example/blog/pie',
      twitterCard: 'summary_large_image',
      jsonLd: { '@context': 'https://schema.org', '@type': 'Article' },
      actorUserId: 'u',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.seo.seoTitle).toBe('Best pie');
    expect(outcome.seo.canonicalUrl).toBe('https://tasteandsee.example/blog/pie');
    expect(outcome.seo.twitterCard).toBe('summary_large_image');
    expect(outcome.seo.jsonLd).toEqual({ '@context': 'https://schema.org', '@type': 'Article' });
    expect(outcome.seo.ogTitle).toBeNull();
    expect(h.emit).toHaveBeenCalledTimes(1);
    const descriptor = h.emit.mock.calls[0]?.[2] as { action: string; before: unknown };
    expect(descriptor.action).toBe('content_article:seo_updated');
    expect(descriptor.before).toMatchObject({ seoTitle: null, jsonLd: null });
    expect(h.emit.mock.calls[0]?.[0]).toBe(h.prisma);
  });

  it('clears a previously-set field (and JSON-LD) with an explicit null; omitted fields are untouched', async () => {
    const articleId = await seedArticle();
    await h.service.updateSeo({
      articleId,
      seoTitle: 'Keep me',
      metaDescription: 'Clear me',
      jsonLd: { a: 1 },
      actorUserId: 'u',
      audit: actor(),
    });

    const outcome = await h.service.updateSeo({
      articleId,
      metaDescription: null,
      jsonLd: null,
      actorUserId: 'u',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.seo.seoTitle).toBe('Keep me'); // omitted → untouched
    expect(outcome.seo.metaDescription).toBeNull(); // explicit null → cleared
    expect(outcome.seo.jsonLd).toBeNull(); // raw NULL clear → wire null
  });

  it('returns article_not_found for an unknown article and does not audit', async () => {
    const outcome = await h.service.updateSeo({
      articleId: 'missing',
      seoTitle: 'x',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'article_not_found' });
    expect(h.emit).not.toHaveBeenCalled();
  });
});

describe('updateComments', () => {
  async function seedArticle(): Promise<string> {
    const created = await h.service.createArticle({
      slug: 'a',
      title: 'A',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!created.ok) throw new Error('precondition');
    return created.article.id;
  }

  it('toggles comments on with an identifier and emits content_article:comments_updated in-tx with the default before', async () => {
    const articleId = await seedArticle();
    h.emit.mockClear();

    const outcome = await h.service.updateComments({
      articleId,
      enabled: true,
      disqusIdentifier: 'blog-pie-guide',
      actorUserId: 'u',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.comments).toEqual({
      enabled: true,
      provider: 'disqus',
      disqusIdentifier: 'blog-pie-guide',
    });
    expect(h.emit).toHaveBeenCalledTimes(1);
    const descriptor = h.emit.mock.calls[0]?.[2] as { action: string; before: unknown };
    expect(descriptor.action).toBe('content_article:comments_updated');
    // A never-configured article's before is the column defaults.
    expect(descriptor.before).toEqual({
      enabled: false,
      provider: 'disqus',
      disqusIdentifier: null,
    });
    expect(h.emit.mock.calls[0]?.[0]).toBe(h.prisma);
  });

  it('switches the provider and toggles off; omitted fields are untouched', async () => {
    const articleId = await seedArticle();
    await h.service.updateComments({
      articleId,
      enabled: true,
      disqusIdentifier: 'keep-me',
      actorUserId: 'u',
      audit: actor(),
    });

    const outcome = await h.service.updateComments({
      articleId,
      enabled: false,
      provider: 'none',
      actorUserId: 'u',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.comments.enabled).toBe(false); // toggled off
    expect(outcome.comments.provider).toBe('none'); // switched
    expect(outcome.comments.disqusIdentifier).toBe('keep-me'); // omitted → untouched
  });

  it('clears the identifier with an explicit null (embed falls back to the slug)', async () => {
    const articleId = await seedArticle();
    await h.service.updateComments({
      articleId,
      disqusIdentifier: 'clear-me',
      actorUserId: 'u',
      audit: actor(),
    });

    const outcome = await h.service.updateComments({
      articleId,
      disqusIdentifier: null,
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome.ok && outcome.comments.disqusIdentifier).toBeNull();
  });

  it('returns article_not_found for an unknown article and does not audit', async () => {
    const outcome = await h.service.updateComments({
      articleId: 'missing',
      enabled: true,
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'article_not_found' });
    expect(h.emit).not.toHaveBeenCalled();
  });
});

describe('appendVersion', () => {
  it('assigns monotonically-increasing version numbers per article', async () => {
    const article = await h.service.createArticle({
      slug: 'about',
      title: 'About',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!article.ok) throw new Error('precondition');

    const v1 = await h.service.appendVersion({
      articleId: article.article.id,
      title: 'v1',
      body: 'first',
      actorUserId: 'author_1',
      audit: actor(),
    });
    const v2 = await h.service.appendVersion({
      articleId: article.article.id,
      title: 'v2',
      body: 'second',
      actorUserId: 'author_1',
      audit: actor(),
    });

    expect(v1.ok && v1.version.versionNo).toBe(1);
    expect(v2.ok && v2.version.versionNo).toBe(2);
    expect(v1.ok && v1.version.createdBy).toBe('author_1');
    expect(v1.ok && v1.version.effectiveAt).toBeNull();
  });

  it('emits content_article_version:create on append', async () => {
    const article = await h.service.createArticle({
      slug: 'press',
      title: 'Press',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!article.ok) throw new Error('precondition');
    h.emit.mockClear();

    await h.service.appendVersion({
      articleId: article.article.id,
      title: 'v1',
      body: 'hello',
      actorUserId: 'u',
      audit: actor(),
    });

    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({ action: 'content_article_version:create' });
  });

  it('returns article_not_found for an unknown article', async () => {
    const outcome = await h.service.appendVersion({
      articleId: 'missing',
      title: 't',
      body: 'b',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'article_not_found' });
  });
});

describe('publishVersion', () => {
  async function seedArticleWithVersion(): Promise<{ articleId: string; versionId: string }> {
    const article = await h.service.createArticle({
      slug: 'a',
      title: 'A',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!article.ok) throw new Error('precondition');
    const version = await h.service.appendVersion({
      articleId: article.article.id,
      title: 'v1',
      body: 'body',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!version.ok) throw new Error('precondition');
    return { articleId: article.article.id, versionId: version.version.id };
  }

  it('flips the article to published, repoints currentVersionId, and stamps effectiveAt', async () => {
    const { articleId, versionId } = await seedArticleWithVersion();
    h.emit.mockClear();

    const outcome = await h.service.publishVersion({
      articleId,
      versionId,
      effectiveAt: undefined,
      actorUserId: 'publisher',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.article.status).toBe('published');
    expect(outcome.article.currentVersionId).toBe(versionId);

    const versionRow = h.prisma.versions.find((v) => v['id'] === versionId);
    expect(versionRow?.['effectiveAt']).toBeInstanceOf(Date);
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({ action: 'content_article:publish' });

    // TS-286: the search-index signal emits in the SAME publish tx (the same
    // fake tx client the audit emit received), alongside the audit event.
    expect(h.emitPublished).toHaveBeenCalledTimes(1);
    expect(h.emitPublished.mock.calls[0]?.[0]).toBe(h.prisma);
    expect(h.emitPublished.mock.calls[0]?.[1]).toMatchObject({
      articleId,
      title: 'v1',
      body: 'body',
      versionNo: 1,
      authorIds: [],
      seoTitle: null,
      metaDescription: null,
    });
  });

  it('carries the ordered byline into the content.article.published projection', async () => {
    const { articleId, versionId } = await seedArticleWithVersion();
    // Seed a byline out of order — the projection must reflect sort_order.
    h.prisma.seedArticleAuthor(articleId, 'author_b', 1);
    h.prisma.seedArticleAuthor(articleId, 'author_a', 0);
    h.emitPublished.mockClear();

    await h.service.publishVersion({
      articleId,
      versionId,
      effectiveAt: undefined,
      actorUserId: 'publisher',
      audit: actor(),
    });

    expect(h.emitPublished).toHaveBeenCalledTimes(1);
    expect(h.emitPublished.mock.calls[0]?.[1]).toMatchObject({
      articleId,
      authorIds: ['author_a', 'author_b'],
    });
  });

  it('does not emit a search event when the publish fails (archived article)', async () => {
    const { articleId, versionId } = await seedArticleWithVersion();
    const articleRow = h.prisma.articles.find((a) => a['id'] === articleId);
    if (articleRow !== undefined) articleRow['status'] = 'archived';
    h.emitPublished.mockClear();

    const outcome = await h.service.publishVersion({
      articleId,
      versionId,
      effectiveAt: undefined,
      actorUserId: 'publisher',
      audit: actor(),
    });

    expect(outcome.ok).toBe(false);
    expect(h.emitPublished).not.toHaveBeenCalled();
  });

  it('honours an explicit effectiveAt', async () => {
    const { articleId, versionId } = await seedArticleWithVersion();
    await h.service.publishVersion({
      articleId,
      versionId,
      effectiveAt: '2026-12-31T00:00:00.000Z',
      actorUserId: 'publisher',
      audit: actor(),
    });
    const versionRow = h.prisma.versions.find((v) => v['id'] === versionId);
    expect((versionRow?.['effectiveAt'] as Date).toISOString()).toBe('2026-12-31T00:00:00.000Z');
  });

  it('returns article_not_found / version_not_found / article_archived in precedence order', async () => {
    const { articleId, versionId } = await seedArticleWithVersion();

    expect(
      await h.service.publishVersion({
        articleId: 'missing',
        versionId,
        effectiveAt: undefined,
        actorUserId: 'u',
        audit: actor(),
      }),
    ).toEqual({ ok: false, reason: 'article_not_found' });

    expect(
      await h.service.publishVersion({
        articleId,
        versionId: 'missing',
        effectiveAt: undefined,
        actorUserId: 'u',
        audit: actor(),
      }),
    ).toEqual({ ok: false, reason: 'version_not_found' });

    const articleRow = h.prisma.articles.find((a) => a['id'] === articleId);
    if (articleRow !== undefined) articleRow['status'] = 'archived';
    expect(
      await h.service.publishVersion({
        articleId,
        versionId,
        effectiveAt: undefined,
        actorUserId: 'u',
        audit: actor(),
      }),
    ).toEqual({ ok: false, reason: 'article_archived' });
  });
});

describe('sendToNewsletter', () => {
  async function seedPublished(): Promise<string> {
    const article = await h.service.createArticle({
      slug: 'p',
      title: 'P',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!article.ok) throw new Error('precondition');
    const version = await h.service.appendVersion({
      articleId: article.article.id,
      title: 'v1',
      body: 'hello world body',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!version.ok) throw new Error('precondition');
    const published = await h.service.publishVersion({
      articleId: article.article.id,
      versionId: version.version.id,
      effectiveAt: undefined,
      actorUserId: 'u',
      audit: actor(),
    });
    if (!published.ok) throw new Error('precondition');
    return article.article.id;
  }

  it('stamps newsletterSentAt and emits audit + newsletter event in the same tx', async () => {
    const articleId = await seedPublished();
    h.emit.mockClear();
    h.emitNewsletter.mockClear();

    const outcome = await h.service.sendToNewsletter({
      articleId,
      actorUserId: 'publisher',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(typeof outcome.newsletterSentAt).toBe('string');

    const row = h.prisma.articles.find((a) => a['id'] === articleId);
    expect(row?.['newsletterSentAt']).toBeInstanceOf(Date);
    expect(row?.['newsletterSentBy']).toBe('publisher');

    // Audit trail (this IS an admin mutation) + the newsletter domain event both
    // emit on the same fake tx client.
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({
      action: 'content_article:newsletter_requested',
    });
    expect(h.emit.mock.calls[0]?.[0]).toBe(h.prisma);
    expect(h.emitNewsletter).toHaveBeenCalledTimes(1);
    expect(h.emitNewsletter.mock.calls[0]?.[0]).toBe(h.prisma);
    expect(h.emitNewsletter.mock.calls[0]?.[1]).toMatchObject({
      articleId,
      title: 'v1',
      excerpt: 'hello world body',
      requestedByUserId: 'publisher',
    });
  });

  it('rejects a draft (never-published) article with not_published and does not emit', async () => {
    const article = await h.service.createArticle({
      slug: 'd',
      title: 'D',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!article.ok) throw new Error('precondition');
    h.emit.mockClear();
    h.emitNewsletter.mockClear();

    const outcome = await h.service.sendToNewsletter({
      articleId: article.article.id,
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_published' });
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.emitNewsletter).not.toHaveBeenCalled();
  });

  it('rejects an unknown article with article_not_found', async () => {
    const outcome = await h.service.sendToNewsletter({
      articleId: 'missing',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'article_not_found' });
    expect(h.emitNewsletter).not.toHaveBeenCalled();
  });

  it('guards a second send with already_sent and does not re-emit', async () => {
    const articleId = await seedPublished();
    const first = await h.service.sendToNewsletter({ articleId, actorUserId: 'u', audit: actor() });
    expect(first.ok).toBe(true);
    h.emit.mockClear();
    h.emitNewsletter.mockClear();

    const second = await h.service.sendToNewsletter({
      articleId,
      actorUserId: 'u',
      audit: actor(),
    });
    expect(second).toEqual({ ok: false, reason: 'already_sent' });
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.emitNewsletter).not.toHaveBeenCalled();
  });
});

describe('reads', () => {
  it('listArticles returns newest-first and filters by status + category', async () => {
    h.prisma.seedCategory('cat_1');
    const a1 = await h.service.createArticle({
      slug: 'a',
      title: 'A',
      actorUserId: 'u',
      audit: actor(),
    });
    await h.service.createArticle({
      slug: 'b',
      title: 'B',
      categoryId: 'cat_1',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!a1.ok) throw new Error('precondition');

    const all = await h.service.listArticles({ limit: 50 });
    expect(all.map((a) => a.slug)).toEqual(['b', 'a']);

    const inCategory = await h.service.listArticles({ categoryId: 'cat_1', limit: 50 });
    expect(inCategory.map((a) => a.slug)).toEqual(['b']);

    const published = await h.service.listArticles({ status: 'published', limit: 50 });
    expect(published).toHaveLength(0);
  });

  it('getArticleDetail returns versions newest-first, or not_found', async () => {
    const article = await h.service.createArticle({
      slug: 'about',
      title: 'About',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!article.ok) throw new Error('precondition');
    await h.service.appendVersion({
      articleId: article.article.id,
      title: 'v1',
      body: '1',
      actorUserId: 'u',
      audit: actor(),
    });
    await h.service.appendVersion({
      articleId: article.article.id,
      title: 'v2',
      body: '2',
      actorUserId: 'u',
      audit: actor(),
    });

    const detail = await h.service.getArticleDetail(article.article.id);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.article.versions.map((v) => v.versionNo)).toEqual([2, 1]);
    // A never-edited article hydrates with an all-null SEO block.
    expect(detail.article.seo).toEqual({
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
    });
    // A never-configured article hydrates with the comments-column defaults.
    expect(detail.article.comments).toEqual({
      enabled: false,
      provider: 'disqus',
      disqusIdentifier: null,
    });

    expect(await h.service.getArticleDetail('missing')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('getVersion scopes to the article and 404s a cross-article id', async () => {
    const article = await h.service.createArticle({
      slug: 'about',
      title: 'About',
      actorUserId: 'u',
      audit: actor(),
    });
    const other = await h.service.createArticle({
      slug: 'terms',
      title: 'Terms',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!article.ok || !other.ok) throw new Error('precondition');
    const version = await h.service.appendVersion({
      articleId: article.article.id,
      title: 'v1',
      body: '1',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!version.ok) throw new Error('precondition');

    expect((await h.service.getVersion(article.article.id, version.version.id)).ok).toBe(true);
    expect(await h.service.getVersion(other.article.id, version.version.id)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});
