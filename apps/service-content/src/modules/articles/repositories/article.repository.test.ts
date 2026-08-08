import { describe, expect, it, vi, beforeEach } from 'vitest';

import { FakeArticlePrisma } from '../services/__fixtures__/fake-prisma';
import { ArticleRepository } from './article.repository';

let prisma: FakeArticlePrisma;
let repo: ArticleRepository;

beforeEach(() => {
  prisma = new FakeArticlePrisma();
  repo = new ArticleRepository(prisma as never);
});

describe('createArticle', () => {
  it('inserts a draft article and runs onPersist inside the transaction', async () => {
    const onPersist = vi.fn(async () => undefined);
    const article = await repo.createArticle(
      { slug: 'welcome', title: 'Welcome', categoryId: null },
      onPersist,
    );

    expect(article.slug).toBe('welcome');
    expect(article.status).toBe('draft');
    expect(article.categoryId).toBeNull();
    expect(article.currentVersionId).toBeNull();
    expect(onPersist).toHaveBeenCalledWith(prisma, article);
  });

  it('finds an article by slug and by id', async () => {
    const article = await repo.createArticle({ slug: 'about', title: 'About', categoryId: null });
    expect((await repo.findArticleBySlug('about'))?.id).toBe(article.id);
    expect((await repo.findArticle(article.id))?.slug).toBe('about');
    expect(await repo.findArticleBySlug('missing')).toBeNull();
  });
});

describe('updateArticle', () => {
  it('patches only supplied fields and runs onPersist in-tx', async () => {
    prisma.seedCategory('cat_1');
    const article = await repo.createArticle({ slug: 'a', title: 'A', categoryId: null });
    const onPersist = vi.fn(async () => undefined);

    const updated = await repo.updateArticle(
      article.id,
      { title: 'A2', categoryId: 'cat_1' },
      onPersist,
    );
    expect(updated.title).toBe('A2');
    expect(updated.categoryId).toBe('cat_1');
    expect(onPersist).toHaveBeenCalledWith(prisma, updated);

    // A null categoryId clears it; an absent field is untouched.
    const cleared = await repo.updateArticle(article.id, { categoryId: null });
    expect(cleared.categoryId).toBeNull();
    expect(cleared.title).toBe('A2');
  });
});

describe('SEO', () => {
  it('updateSeo patches supplied fields, runs onPersist in-tx, and findSeo reads them back', async () => {
    const article = await repo.createArticle({ slug: 'a', title: 'A', categoryId: null });
    const onPersist = vi.fn(async () => undefined);

    const updated = await repo.updateSeo(
      article.id,
      { seoTitle: 'T', jsonLd: { '@type': 'Article' } },
      onPersist,
    );
    expect(updated.seoTitle).toBe('T');
    expect(updated.jsonLd).toEqual({ '@type': 'Article' });
    expect(onPersist).toHaveBeenCalledWith(prisma, updated);

    const read = await repo.findSeo(article.id);
    expect(read?.seoTitle).toBe('T');
    expect(await repo.findSeo('missing')).toBeNull();
  });

  it('clears jsonLd to SQL NULL via the raw UPDATE path', async () => {
    const article = await repo.createArticle({ slug: 'a', title: 'A', categoryId: null });
    await repo.updateSeo(article.id, { jsonLd: { a: 1 } });
    const cleared = await repo.updateSeo(article.id, { jsonLd: null });
    expect(cleared.jsonLd).toBeNull();
  });

  it('findDetail includes the SEO block', async () => {
    const article = await repo.createArticle({ slug: 'a', title: 'A', categoryId: null });
    await repo.updateSeo(article.id, { canonicalUrl: 'https://x.example/a' });
    const detail = await repo.findDetail(article.id);
    expect(detail?.seo.canonicalUrl).toBe('https://x.example/a');
  });
});

describe('helpCategoryExists', () => {
  it('reports category existence for the assignment guard', async () => {
    prisma.seedCategory('cat_1');
    expect(await repo.helpCategoryExists('cat_1')).toBe(true);
    expect(await repo.helpCategoryExists('missing')).toBe(false);
  });
});

describe('listArticles', () => {
  it('returns newest-first, honours the limit, and filters by status + category', async () => {
    prisma.seedCategory('cat_1');
    await repo.createArticle({ slug: 'a', title: 'A', categoryId: null });
    const b = await repo.createArticle({ slug: 'b', title: 'B', categoryId: 'cat_1' });
    await repo.createArticle({ slug: 'c', title: 'C', categoryId: null });

    const all = await repo.listArticles({ limit: 50 });
    expect(all.map((a) => a.slug)).toEqual(['c', 'b', 'a']);

    const limited = await repo.listArticles({ limit: 2 });
    expect(limited).toHaveLength(2);

    const inCategory = await repo.listArticles({ categoryId: 'cat_1', limit: 50 });
    expect(inCategory.map((a) => a.slug)).toEqual(['b']);

    const row = prisma.articles.find((a) => a['id'] === b.id);
    if (row !== undefined) row['status'] = 'published';
    const published = await repo.listArticles({ status: 'published', limit: 50 });
    expect(published.map((a) => a.slug)).toEqual(['b']);
  });
});

describe('appendVersion', () => {
  it('assigns monotonic per-article version numbers, independent across articles', async () => {
    const a = await repo.createArticle({ slug: 'a', title: 'A', categoryId: null });
    const b = await repo.createArticle({ slug: 'b', title: 'B', categoryId: null });
    const a1 = await repo.appendVersion(a.id, { title: 'a1', body: '1', createdBy: 'u' });
    const a2 = await repo.appendVersion(a.id, { title: 'a2', body: '2', createdBy: 'u' });
    const b1 = await repo.appendVersion(b.id, { title: 'b1', body: 'y', createdBy: 'u' });

    expect(a1.versionNo).toBe(1);
    expect(a2.versionNo).toBe(2);
    expect(a1.effectiveAt).toBeNull();
    expect(b1.versionNo).toBe(1);
  });

  it('findDetail returns versions newest-first; findVersion scopes by article', async () => {
    const a = await repo.createArticle({ slug: 'about', title: 'About', categoryId: null });
    const other = await repo.createArticle({ slug: 'terms', title: 'Terms', categoryId: null });
    await repo.appendVersion(a.id, { title: 'v1', body: '1', createdBy: 'u' });
    const v2 = await repo.appendVersion(a.id, { title: 'v2', body: '2', createdBy: 'u' });

    const detail = await repo.findDetail(a.id);
    expect(detail?.versions.map((v) => v.versionNo)).toEqual([2, 1]);
    expect(await repo.findDetail('missing')).toBeNull();

    expect((await repo.findVersion(a.id, v2.id))?.id).toBe(v2.id);
    expect(await repo.findVersion(other.id, v2.id)).toBeNull();
  });
});

describe('publishVersion', () => {
  it('stamps effectiveAt, repoints currentVersionId, moves the article to published, and audits in-tx', async () => {
    const article = await repo.createArticle({ slug: 'a', title: 'A', categoryId: null });
    const version = await repo.appendVersion(article.id, {
      title: 'v1',
      body: '1',
      createdBy: 'u',
    });
    const effectiveAt = new Date(Date.UTC(2026, 6, 1));
    const onPersist = vi.fn(async () => undefined);

    const result = await repo.publishVersion(article.id, version.id, effectiveAt, onPersist);

    expect(result.article.status).toBe('published');
    expect(result.article.currentVersionId).toBe(version.id);
    expect(result.version.effectiveAt?.toISOString()).toBe(effectiveAt.toISOString());
    expect(onPersist).toHaveBeenCalledWith(prisma, result);
  });
});
