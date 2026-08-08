import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PUBLIC_BLOG_SCAN_CAP, PublicBlogRepository } from './public-blog.repository';

/**
 * A recording stub Prisma — these tests pin the QUERY SHAPES (the load-bearing
 * `status: 'published'` predicates and the explicit column projections that
 * keep internal fields off the public path), not row mechanics; the service
 * tests cover behavior over the returned rows.
 */
interface RecordingPrisma {
  article: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  articleVersion: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  articleAuthor: { findMany: ReturnType<typeof vi.fn> };
}

let prisma: RecordingPrisma;
let repo: PublicBlogRepository;

beforeEach(() => {
  prisma = {
    article: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    articleVersion: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    articleAuthor: { findMany: vi.fn(async () => []) },
  };
  repo = new PublicBlogRepository(prisma as never);
});

describe('listPublishedArticles', () => {
  it('scans ONLY published articles with a live head pointer, capped', async () => {
    await repo.listPublishedArticles();

    const args = prisma.article.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      take: number;
      select: Record<string, unknown>;
    };
    expect(args.where).toEqual({ status: 'published', currentVersionId: { not: null } });
    expect(args.take).toBe(PUBLIC_BLOG_SCAN_CAP);
    // The card projection must never widen to internal fields.
    expect(Object.keys(args.select).sort()).toEqual([
      'category',
      'createdAt',
      'currentVersionId',
      'id',
      'metaDescription',
      'slug',
      'title',
    ]);
  });
});

describe('findPublishedBySlug', () => {
  it('carries the published predicate in the where — a draft slug probe is a plain miss', async () => {
    expect(await repo.findPublishedBySlug('some-draft')).toBeNull();

    const args = prisma.article.findFirst.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(args.where).toEqual({ slug: 'some-draft', status: 'published' });
    const selected = Object.keys(args.select);
    expect(selected).not.toContain('newsletterSentAt');
    expect(selected).not.toContain('newsletterSentBy');
    expect(selected).not.toContain('status');
  });

  it('splits the flat row into card facts + the SEO block', async () => {
    prisma.article.findFirst.mockResolvedValue({
      id: 'art_1',
      slug: 'hello',
      title: 'Hello',
      currentVersionId: 'ver_1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      category: null,
      commentsEnabled: true,
      commentsProvider: 'disqus',
      disqusIdentifier: null,
      seoTitle: 'SEO',
      metaDescription: 'Desc',
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

    const row = await repo.findPublishedBySlug('hello');
    expect(row?.seo.seoTitle).toBe('SEO');
    expect(row?.seo.metaDescription).toBe('Desc');
    expect(row?.commentsEnabled).toBe(true);
    expect(row).not.toHaveProperty('seoTitle');
  });
});

describe('findHeadVersionWithBody', () => {
  it('scopes the version to its article and projects no createdBy', async () => {
    await repo.findHeadVersionWithBody('art_1', 'ver_1');

    const args = prisma.articleVersion.findFirst.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(args.where).toEqual({ id: 'ver_1', articleId: 'art_1' });
    expect(Object.keys(args.select).sort()).toEqual(['body', 'effectiveAt', 'id', 'title']);
  });
});

describe('batch reads', () => {
  it('short-circuit on empty id batches without touching the client', async () => {
    expect(await repo.findHeadVersionMeta([])).toEqual([]);
    expect(await repo.listPrimaryAuthors([])).toEqual([]);
    expect(prisma.articleVersion.findMany).not.toHaveBeenCalled();
    expect(prisma.articleAuthor.findMany).not.toHaveBeenCalled();
  });

  it('reads primary authors at byline position 0 only, without the userId', async () => {
    await repo.listPrimaryAuthors(['a1', 'a2']);
    const args = prisma.articleAuthor.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      select: { author: { select: Record<string, unknown> } };
    };
    expect(args.where).toEqual({ articleId: { in: ['a1', 'a2'] }, sortOrder: 0 });
    expect(Object.keys(args.select.author.select).sort()).toEqual(['displayName', 'photoAssetKey']);
  });

  it('reads the full byline ordered by position, never projecting userId', async () => {
    await repo.listByline('a1');
    const args = prisma.articleAuthor.findMany.mock.calls[0]?.[0] as {
      orderBy: unknown;
      select: { author: { select: Record<string, unknown> } };
    };
    expect(args.orderBy).toEqual([{ sortOrder: 'asc' }, { authorId: 'asc' }]);
    expect(Object.keys(args.select.author.select)).not.toContain('userId');
  });
});
