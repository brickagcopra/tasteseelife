import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type {
  ArticleComments,
  ArticleDetail,
  ArticleRecord,
  ArticleSeo,
  ArticleVersionRecord,
} from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import { ArticlesService } from '../services/articles.service';
import { ArticlesController } from './articles.controller';

const TS = '2026-06-30T00:00:00.000Z';

function articleRecord(overrides: Partial<ArticleRecord> = {}): ArticleRecord {
  return {
    id: 'art_1',
    slug: 'welcome',
    status: 'draft',
    title: 'Welcome',
    categoryId: null,
    currentVersionId: null,
    newsletterSentAt: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function versionRecord(overrides: Partial<ArticleVersionRecord> = {}): ArticleVersionRecord {
  return {
    id: 'ver_1',
    articleId: 'art_1',
    versionNo: 1,
    title: 'Welcome',
    body: 'Hello there.',
    effectiveAt: null,
    createdBy: 'user_admin',
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function emptySeo(overrides: Partial<ArticleSeo> = {}): ArticleSeo {
  return {
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
    ...overrides,
  };
}

function defaultComments(overrides: Partial<ArticleComments> = {}): ArticleComments {
  return {
    enabled: false,
    provider: 'disqus',
    disqusIdentifier: null,
    ...overrides,
  };
}

interface FakeService {
  listArticles: ReturnType<typeof vi.fn>;
  createArticle: ReturnType<typeof vi.fn>;
  updateArticle: ReturnType<typeof vi.fn>;
  updateSeo: ReturnType<typeof vi.fn>;
  updateComments: ReturnType<typeof vi.fn>;
  getArticleDetail: ReturnType<typeof vi.fn>;
  appendVersion: ReturnType<typeof vi.fn>;
  getVersion: ReturnType<typeof vi.fn>;
  publishVersion: ReturnType<typeof vi.fn>;
  sendToNewsletter: ReturnType<typeof vi.fn>;
}

function build(overrides: Partial<FakeService> = {}): {
  controller: ArticlesController;
  service: FakeService;
} {
  const detail: ArticleDetail = {
    ...articleRecord(),
    versions: [versionRecord()],
    seo: emptySeo(),
    comments: defaultComments(),
  };
  const service: FakeService = {
    listArticles: vi.fn(async (): Promise<readonly ArticleRecord[]> => [articleRecord()]),
    createArticle: vi.fn(async () => ({ ok: true, article: articleRecord() })),
    updateArticle: vi.fn(async () => ({ ok: true, article: articleRecord({ title: 'Renamed' }) })),
    updateSeo: vi.fn(async () => ({ ok: true, seo: emptySeo({ seoTitle: 'Best pie' }) })),
    updateComments: vi.fn(async () => ({
      ok: true,
      comments: defaultComments({ enabled: true, disqusIdentifier: 'blog-pie-guide' }),
    })),
    getArticleDetail: vi.fn(async () => ({ ok: true, article: detail })),
    appendVersion: vi.fn(async () => ({ ok: true, version: versionRecord() })),
    getVersion: vi.fn(async () => ({ ok: true, version: versionRecord() })),
    publishVersion: vi.fn(async () => ({
      ok: true,
      article: articleRecord({ status: 'published', currentVersionId: 'ver_1' }),
    })),
    sendToNewsletter: vi.fn(async () => ({
      ok: true,
      newsletterSentAt: '2026-06-30T09:00:00.000Z',
    })),
    ...overrides,
  };
  const controller = new ArticlesController(service as unknown as ArticlesService);
  return { controller, service };
}

function adminRequest(userId = 'user_admin'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return {
    requestContext: ctx,
    ip: '203.0.113.9',
    headers: { 'user-agent': 'jest', 'x-request-id': 'req_test' },
  } as unknown as RequestWithContext;
}

describe('ArticlesController.list', () => {
  it('returns matching articles and forwards filters', async () => {
    const { controller, service } = build();
    const response = await controller.list({ limit: 50, status: 'published', categoryId: 'cat_1' });
    expect(response.articles).toHaveLength(1);
    expect(service.listArticles).toHaveBeenCalledWith({
      status: 'published',
      categoryId: 'cat_1',
      limit: 50,
    });
  });
});

describe('ArticlesController.create', () => {
  const body = { slug: 'welcome', title: 'Welcome' };

  it('creates and attributes the actor from the token', async () => {
    const { controller, service } = build();
    const response = await controller.create(body, adminRequest('admin_42'));
    expect(response.article.slug).toBe('welcome');
    expect(service.createArticle).toHaveBeenCalledWith(
      expect.objectContaining({
        ...body,
        actorUserId: 'admin_42',
        audit: expect.objectContaining({ actorUserId: 'admin_42', userAgent: 'jest' }),
      }),
    );
  });

  it('maps a slug conflict to 409 and a bad category to 404', async () => {
    const conflict = build({
      createArticle: vi.fn(async () => ({ ok: false, reason: 'slug_conflict' })),
    });
    await expect(conflict.controller.create(body, adminRequest())).rejects.toBeInstanceOf(
      ConflictException,
    );

    const badCat = build({
      createArticle: vi.fn(async () => ({ ok: false, reason: 'category_not_found' })),
    });
    await expect(
      badCat.controller.create({ ...body, categoryId: 'missing' }, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a request with no auth context', async () => {
    const { controller } = build();
    await expect(
      controller.create(body, { requestContext: undefined } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('ArticlesController.update', () => {
  it('updates metadata and forwards the actor', async () => {
    const { controller, service } = build();
    const response = await controller.update(
      'art_1',
      { title: 'Renamed' },
      adminRequest('admin_9'),
    );
    expect(response.article.title).toBe('Renamed');
    expect(service.updateArticle).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: 'art_1', title: 'Renamed', actorUserId: 'admin_9' }),
    );
  });

  it('maps article_not_found to 404 and category_not_found to 404', async () => {
    const missing = build({
      updateArticle: vi.fn(async () => ({ ok: false, reason: 'article_not_found' })),
    });
    await expect(
      missing.controller.update('art_x', { title: 'x' }, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);

    const badCat = build({
      updateArticle: vi.fn(async () => ({ ok: false, reason: 'category_not_found' })),
    });
    await expect(
      badCat.controller.update('art_1', { categoryId: 'missing' }, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ArticlesController.updateSeo', () => {
  const body = { seoTitle: 'Best pie', canonicalUrl: 'https://tasteandsee.example/blog/pie' };

  it('updates SEO and threads the actor via the service', async () => {
    const { controller, service } = build();
    const response = await controller.updateSeo('art_1', body, adminRequest('admin_9'));
    expect(response.seo.seoTitle).toBe('Best pie');
    expect(service.updateSeo).toHaveBeenCalledWith(
      expect.objectContaining({ ...body, articleId: 'art_1', actorUserId: 'admin_9' }),
    );
  });

  it('maps article_not_found to 404', async () => {
    const { controller } = build({
      updateSeo: vi.fn(async () => ({ ok: false, reason: 'article_not_found' })),
    });
    await expect(controller.updateSeo('art_x', body, adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a request with no auth context (401)', async () => {
    const { controller } = build();
    await expect(
      controller.updateSeo('art_1', body, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('ArticlesController.updateComments', () => {
  const body = { enabled: true, disqusIdentifier: 'blog-pie-guide' };

  it('updates the comments config and threads the actor via the service', async () => {
    const { controller, service } = build();
    const response = await controller.updateComments('art_1', body, adminRequest('admin_9'));
    expect(response.comments.enabled).toBe(true);
    expect(response.comments.disqusIdentifier).toBe('blog-pie-guide');
    expect(service.updateComments).toHaveBeenCalledWith(
      expect.objectContaining({ ...body, articleId: 'art_1', actorUserId: 'admin_9' }),
    );
  });

  it('maps article_not_found to 404', async () => {
    const { controller } = build({
      updateComments: vi.fn(async () => ({ ok: false, reason: 'article_not_found' })),
    });
    await expect(controller.updateComments('art_x', body, adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a request with no auth context (401)', async () => {
    const { controller } = build();
    await expect(
      controller.updateComments('art_1', body, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('ArticlesController.detail', () => {
  it('hydrates the comments config on the detail', async () => {
    const { controller } = build();
    const response = await controller.detail('art_1');
    expect(response.article.comments).toEqual({
      enabled: false,
      provider: 'disqus',
      disqusIdentifier: null,
    });
  });

  it('hydrates the SEO block on the detail', async () => {
    const { controller } = build();
    const response = await controller.detail('art_1');
    expect(response.article.seo).toBeDefined();
    expect(response.article.seo.seoTitle).toBeNull();
  });

  it('returns the article detail with versions', async () => {
    const { controller } = build();
    const response = await controller.detail('art_1');
    expect(response.article.versions).toHaveLength(1);
  });

  it('maps not_found to 404', async () => {
    const { controller } = build({
      getArticleDetail: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
    });
    await expect(controller.detail('art_x')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ArticlesController.appendVersion', () => {
  const body = { title: 'v2', body: 'updated copy' };

  it('appends and threads the actor via the service', async () => {
    const { controller, service } = build();
    const response = await controller.appendVersion('art_1', body, adminRequest('admin_9'));
    expect(response.version.id).toBe('ver_1');
    expect(service.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({ ...body, articleId: 'art_1', actorUserId: 'admin_9' }),
    );
  });

  it('maps article_not_found to 404', async () => {
    const { controller } = build({
      appendVersion: vi.fn(async () => ({ ok: false, reason: 'article_not_found' })),
    });
    await expect(controller.appendVersion('art_x', body, adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a request with no auth context (401)', async () => {
    const { controller } = build();
    await expect(
      controller.appendVersion('art_1', body, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('ArticlesController.version', () => {
  it('returns the single version', async () => {
    const { controller } = build();
    const response = await controller.version('art_1', 'ver_1');
    expect(response.version.id).toBe('ver_1');
  });

  it('maps not_found to 404', async () => {
    const { controller } = build({
      getVersion: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
    });
    await expect(controller.version('art_1', 'ver_x')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ArticlesController.publish', () => {
  it('publishes and returns the published article', async () => {
    const { controller, service } = build();
    const response = await controller.publish('art_1', 'ver_1', {}, adminRequest('publisher_1'));
    expect(response.article.status).toBe('published');
    expect(service.publishVersion).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: 'art_1', versionId: 'ver_1', effectiveAt: undefined }),
    );
  });

  it('forwards an explicit effectiveAt', async () => {
    const { controller, service } = build();
    await controller.publish(
      'art_1',
      'ver_1',
      { effectiveAt: '2026-12-31T00:00:00.000Z' },
      adminRequest(),
    );
    expect(service.publishVersion).toHaveBeenCalledWith(
      expect.objectContaining({ effectiveAt: '2026-12-31T00:00:00.000Z' }),
    );
  });

  it('maps article_archived to 409 and version_not_found to 404', async () => {
    const archived = build({
      publishVersion: vi.fn(async () => ({ ok: false, reason: 'article_archived' })),
    });
    await expect(
      archived.controller.publish('art_1', 'ver_1', {}, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);

    const missing = build({
      publishVersion: vi.fn(async () => ({ ok: false, reason: 'version_not_found' })),
    });
    await expect(
      missing.controller.publish('art_1', 'ver_x', {}, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ArticlesController.sendToNewsletter', () => {
  it('sends and returns the newsletterSentAt timestamp', async () => {
    const { controller, service } = build();
    const response = await controller.sendToNewsletter('art_1', {}, adminRequest('publisher_1'));
    expect(response.newsletterSentAt).toBe('2026-06-30T09:00:00.000Z');
    expect(service.sendToNewsletter).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: 'art_1', actorUserId: 'publisher_1' }),
    );
  });

  it('maps not_published + already_sent to 409 and article_not_found to 404', async () => {
    const notPublished = build({
      sendToNewsletter: vi.fn(async () => ({ ok: false, reason: 'not_published' })),
    });
    await expect(
      notPublished.controller.sendToNewsletter('art_1', {}, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);

    const alreadySent = build({
      sendToNewsletter: vi.fn(async () => ({ ok: false, reason: 'already_sent' })),
    });
    await expect(
      alreadySent.controller.sendToNewsletter('art_1', {}, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);

    const missing = build({
      sendToNewsletter: vi.fn(async () => ({ ok: false, reason: 'article_not_found' })),
    });
    await expect(
      missing.controller.sendToNewsletter('art_x', {}, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a request with no auth context (401)', async () => {
    const { controller } = build();
    await expect(
      controller.sendToNewsletter('art_1', {}, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
