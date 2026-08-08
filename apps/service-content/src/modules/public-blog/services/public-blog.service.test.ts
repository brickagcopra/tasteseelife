import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PublicArticleDetailRow,
  PublicArticleListRow,
  PublicBlogRepository,
  PublicBylineRow,
  PublicHeadVersionBodyRow,
  PublicHeadVersionRow,
  PublicPrimaryAuthorRow,
} from '../repositories/public-blog.repository';
import { PublicBlogService } from './public-blog.service';

const EMPTY_SEO = {
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

function listRow(overrides: Partial<PublicArticleListRow> = {}): PublicArticleListRow {
  return {
    id: 'art_1',
    slug: 'first-post',
    title: 'First post',
    metaDescription: null,
    currentVersionId: 'ver_1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    category: null,
    ...overrides,
  };
}

function detailRow(overrides: Partial<PublicArticleDetailRow> = {}): PublicArticleDetailRow {
  return {
    id: 'art_1',
    slug: 'first-post',
    title: 'First post',
    currentVersionId: 'ver_1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    category: null,
    seo: EMPTY_SEO,
    commentsEnabled: false,
    commentsProvider: 'disqus',
    disqusIdentifier: null,
    ...overrides,
  };
}

interface FakeRepo {
  listPublishedArticles: ReturnType<typeof vi.fn>;
  findHeadVersionMeta: ReturnType<typeof vi.fn>;
  listPrimaryAuthors: ReturnType<typeof vi.fn>;
  findPublishedBySlug: ReturnType<typeof vi.fn>;
  findHeadVersionWithBody: ReturnType<typeof vi.fn>;
  listByline: ReturnType<typeof vi.fn>;
}

function buildRepo(overrides: Partial<FakeRepo> = {}): FakeRepo {
  return {
    listPublishedArticles: vi.fn(async (): Promise<readonly PublicArticleListRow[]> => []),
    findHeadVersionMeta: vi.fn(async (): Promise<readonly PublicHeadVersionRow[]> => []),
    listPrimaryAuthors: vi.fn(async (): Promise<readonly PublicPrimaryAuthorRow[]> => []),
    findPublishedBySlug: vi.fn(async (): Promise<PublicArticleDetailRow | null> => null),
    findHeadVersionWithBody: vi.fn(async (): Promise<PublicHeadVersionBodyRow | null> => null),
    listByline: vi.fn(async (): Promise<readonly PublicBylineRow[]> => []),
    ...overrides,
  };
}

let repo: FakeRepo;
let service: PublicBlogService;

beforeEach(() => {
  repo = buildRepo();
  service = new PublicBlogService(repo as unknown as PublicBlogRepository);
});

describe('listArticles', () => {
  it('orders by head-version publishedAt descending, not row creation order', async () => {
    repo.listPublishedArticles.mockResolvedValue([
      listRow({ id: 'art_old', slug: 'older', currentVersionId: 'ver_old' }),
      listRow({ id: 'art_new', slug: 'newer', currentVersionId: 'ver_new' }),
    ]);
    repo.findHeadVersionMeta.mockResolvedValue([
      { id: 'ver_old', effectiveAt: new Date('2026-01-05T00:00:00Z') },
      { id: 'ver_new', effectiveAt: new Date('2026-06-05T00:00:00Z') },
    ]);

    const result = await service.listArticles({ page: 1 });
    expect(result.articles.map((a) => a.slug)).toEqual(['newer', 'older']);
    expect(result.articles[0]?.publishedAt).toBe('2026-06-05T00:00:00.000Z');
  });

  it('filters by category slug but derives the categories bar from the FULL published set', async () => {
    repo.listPublishedArticles.mockResolvedValue([
      listRow({
        id: 'a1',
        slug: 'stories-post',
        currentVersionId: 'v1',
        category: { slug: 'stories', name: 'Stories' },
      }),
      listRow({
        id: 'a2',
        slug: 'recipes-post',
        currentVersionId: 'v2',
        category: { slug: 'recipes', name: 'Recipes' },
      }),
    ]);
    repo.findHeadVersionMeta.mockResolvedValue([
      { id: 'v1', effectiveAt: new Date('2026-02-01T00:00:00Z') },
      { id: 'v2', effectiveAt: new Date('2026-03-01T00:00:00Z') },
    ]);

    const result = await service.listArticles({ page: 1, categorySlug: 'stories' });
    expect(result.articles.map((a) => a.slug)).toEqual(['stories-post']);
    expect(result.totalArticles).toBe(1);
    // Filter bar still shows every in-use category, alphabetical by name.
    expect(result.categories).toEqual([
      { slug: 'recipes', name: 'Recipes' },
      { slug: 'stories', name: 'Stories' },
    ]);
  });

  it('paginates with fixed page size and returns empty (200-shaped) beyond the last page', async () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      listRow({
        id: `a${i}`,
        slug: `post-${String(i).padStart(2, '0')}`,
        currentVersionId: `v${i}`,
      }),
    );
    repo.listPublishedArticles.mockResolvedValue(rows);
    repo.findHeadVersionMeta.mockResolvedValue(
      rows.map((r, i) => ({
        id: r.currentVersionId,
        effectiveAt: new Date(Date.UTC(2026, 0, 1 + i)),
      })),
    );

    const page1 = await service.listArticles({ page: 1 });
    expect(page1.articles).toHaveLength(12);
    expect(page1).toMatchObject({ page: 1, pageSize: 12, totalArticles: 15, totalPages: 2 });

    const page2 = await service.listArticles({ page: 2 });
    expect(page2.articles).toHaveLength(3);

    const beyond = await service.listArticles({ page: 9 });
    expect(beyond.articles).toEqual([]);
    expect(beyond.totalPages).toBe(2);
  });

  it('drops a published row whose head version does not resolve (never a hole in the page)', async () => {
    repo.listPublishedArticles.mockResolvedValue([
      listRow({ id: 'a1', slug: 'ok', currentVersionId: 'v1' }),
      listRow({ id: 'a2', slug: 'dangling', currentVersionId: 'v_missing' }),
    ]);
    repo.findHeadVersionMeta.mockResolvedValue([
      { id: 'v1', effectiveAt: new Date('2026-02-01T00:00:00Z') },
    ]);

    const result = await service.listArticles({ page: 1 });
    expect(result.articles.map((a) => a.slug)).toEqual(['ok']);
  });

  it('attaches the position-0 byline author to each card, null when uncredited', async () => {
    repo.listPublishedArticles.mockResolvedValue([
      listRow({ id: 'a1', slug: 'credited', currentVersionId: 'v1' }),
      listRow({ id: 'a2', slug: 'uncredited', currentVersionId: 'v2' }),
    ]);
    repo.findHeadVersionMeta.mockResolvedValue([
      { id: 'v1', effectiveAt: new Date('2026-05-01T00:00:00Z') },
      { id: 'v2', effectiveAt: new Date('2026-04-01T00:00:00Z') },
    ]);
    repo.listPrimaryAuthors.mockResolvedValue([
      { articleId: 'a1', author: { displayName: 'Chef Maria', photoAssetKey: null } },
    ]);

    const result = await service.listArticles({ page: 1 });
    expect(result.articles[0]?.primaryAuthor).toEqual({
      displayName: 'Chef Maria',
      photoAssetKey: null,
    });
    expect(result.articles[1]?.primaryAuthor).toBeNull();
    // The batch read is scoped to the page's ids only.
    expect(repo.listPrimaryAuthors).toHaveBeenCalledWith(['a1', 'a2']);
  });
});

describe('getArticleBySlug', () => {
  it('is not_found when the repository resolves nothing (draft/archived/missing are uniform)', async () => {
    expect(await service.getArticleBySlug('anything')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('is not_found when a published row has no head version pointer', async () => {
    repo.findPublishedBySlug.mockResolvedValue(detailRow({ currentVersionId: null }));
    expect(await service.getArticleBySlug('first-post')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(repo.findHeadVersionWithBody).not.toHaveBeenCalled();
  });

  it('is not_found when the head version row does not resolve', async () => {
    repo.findPublishedBySlug.mockResolvedValue(detailRow());
    expect(await service.getArticleBySlug('first-post')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('serves the live body, publishedAt, byline order, and SEO block', async () => {
    repo.findPublishedBySlug.mockResolvedValue(
      detailRow({
        category: { slug: 'stories', name: 'Stories' },
        seo: { ...EMPTY_SEO, seoTitle: 'Custom SEO title', twitterCard: 'summary' },
      }),
    );
    repo.findHeadVersionWithBody.mockResolvedValue({
      id: 'ver_1',
      effectiveAt: new Date('2026-06-01T09:00:00Z'),
      title: 'First post',
      body: '## Hello',
    });
    repo.listByline.mockResolvedValue([
      {
        role: 'primary',
        sortOrder: 0,
        author: { displayName: 'Chef Maria', bio: 'Bio', photoAssetKey: null, socialLinks: null },
      },
      {
        role: 'co_author',
        sortOrder: 1,
        author: {
          displayName: 'Sam Cole',
          bio: null,
          photoAssetKey: 'asset_1',
          socialLinks: { website: 'https://example.com' },
        },
      },
    ]);

    const outcome = await service.getArticleBySlug('first-post');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.article.body).toBe('## Hello');
    expect(outcome.article.publishedAt).toBe('2026-06-01T09:00:00.000Z');
    expect(outcome.article.category).toEqual({ slug: 'stories', name: 'Stories' });
    expect(outcome.article.seo.seoTitle).toBe('Custom SEO title');
    expect(outcome.article.authors.map((a) => a.displayName)).toEqual(['Chef Maria', 'Sam Cole']);
    expect(outcome.article.authors[1]?.socialLinks).toEqual({ website: 'https://example.com' });
    expect(repo.findHeadVersionWithBody).toHaveBeenCalledWith('art_1', 'ver_1');
  });

  it('serves comments config ONLY when enabled (a comments-dark post carries null)', async () => {
    repo.findPublishedBySlug.mockResolvedValue(detailRow({ commentsEnabled: false }));
    repo.findHeadVersionWithBody.mockResolvedValue({
      id: 'ver_1',
      effectiveAt: new Date('2026-06-01T09:00:00Z'),
      title: 'First post',
      body: 'Body',
    });
    const dark = await service.getArticleBySlug('first-post');
    expect(dark.ok && dark.article.comments).toBeNull();

    repo.findPublishedBySlug.mockResolvedValue(
      detailRow({ commentsEnabled: true, disqusIdentifier: 'thread-1' }),
    );
    const lit = await service.getArticleBySlug('first-post');
    expect(lit.ok && lit.article.comments).toEqual({
      provider: 'disqus',
      disqusIdentifier: 'thread-1',
    });
  });
});
