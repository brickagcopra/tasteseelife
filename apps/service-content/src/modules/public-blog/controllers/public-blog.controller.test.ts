import { NotFoundException } from '@nestjs/common';
import type { PublicBlogArticle, PublicBlogArticlesListResponse } from '@taste-and-see/contracts';
import type { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublicBlogMetrics } from '../public-blog-metrics';
import type { PublicBlogService } from '../services/public-blog.service';
import { PublicBlogController } from './public-blog.controller';

/** A tenant store whose `run` invokes the callback — pins that every handler
 *  routes through `runWithoutTenantContext` (the exempt frame the app.module
 *  doc-block mandates for the first anonymous entrypoint). */
function buildStore(): TenantContextStore & { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn((_frame: unknown, fn: () => unknown) => fn()) } as never;
}

const ARTICLE: PublicBlogArticle = {
  slug: 'first-post',
  title: 'First post',
  body: '## Hello',
  publishedAt: '2026-06-01T09:00:00.000Z',
  category: { slug: 'stories', name: 'Stories' },
  seo: {
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
  },
  authors: [],
  comments: null,
};

const LIST: PublicBlogArticlesListResponse = {
  articles: [],
  page: 1,
  pageSize: 12,
  totalArticles: 0,
  totalPages: 0,
  categories: [],
};

interface Harness {
  controller: PublicBlogController;
  service: { listArticles: ReturnType<typeof vi.fn>; getArticleBySlug: ReturnType<typeof vi.fn> };
  metrics: { recordRead: ReturnType<typeof vi.fn> };
  store: ReturnType<typeof buildStore>;
}

function build(): Harness {
  const service = {
    listArticles: vi.fn(async () => LIST),
    getArticleBySlug: vi.fn(async () => ({ ok: true as const, article: ARTICLE })),
  };
  const metrics = { recordRead: vi.fn() };
  const store = buildStore();
  const controller = new PublicBlogController(
    service as unknown as PublicBlogService,
    metrics as unknown as PublicBlogMetrics,
    store,
  );
  return { controller, service, metrics, store };
}

let h: Harness;
beforeEach(() => {
  h = build();
});

describe('list', () => {
  it('serves the index inside an exempt tenant frame and records the metric', async () => {
    const result = await h.controller.list({ page: 1 });
    expect(result).toEqual(LIST);
    expect(h.store.run).toHaveBeenCalledWith(
      { kind: 'exempt', reason: 'content-public-blog-read' },
      expect.any(Function),
    );
    expect(h.metrics.recordRead).toHaveBeenCalledWith('list', 'ok');
    expect(h.service.listArticles).toHaveBeenCalledWith({ page: 1, categorySlug: undefined });
  });

  it('threads the category filter through', async () => {
    await h.controller.list({ page: 2, category: 'stories' });
    expect(h.service.listArticles).toHaveBeenCalledWith({ page: 2, categorySlug: 'stories' });
  });

  it('rejects an over-sharing service payload at the boundary parse', async () => {
    h.service.listArticles.mockResolvedValue({ ...LIST, drafts: [] });
    await expect(h.controller.list({ page: 1 })).rejects.toThrow();
  });
});

describe('detail', () => {
  it('serves a published article inside an exempt frame', async () => {
    const result = await h.controller.detail('first-post');
    expect(result.article.slug).toBe('first-post');
    expect(h.store.run).toHaveBeenCalledWith(
      { kind: 'exempt', reason: 'content-public-blog-read' },
      expect.any(Function),
    );
    expect(h.metrics.recordRead).toHaveBeenCalledWith('detail', 'ok');
  });

  it('maps not_found to a uniform RFC 7807 404 and counts it', async () => {
    h.service.getArticleBySlug.mockResolvedValue({ ok: false, reason: 'not_found' });

    await expect(h.controller.detail('a-draft-slug')).rejects.toMatchObject({
      constructor: NotFoundException,
      response: {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: "No published article found for slug 'a-draft-slug'.",
      },
    });
    expect(h.metrics.recordRead).toHaveBeenCalledWith('detail', 'not_found');
  });

  it('rejects an article body that widened past the public contract', async () => {
    h.service.getArticleBySlug.mockResolvedValue({
      ok: true,
      article: { ...ARTICLE, createdBy: 'usr_staff' },
    });
    await expect(h.controller.detail('first-post')).rejects.toThrow();
  });
});
