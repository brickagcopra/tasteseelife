import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { AdminContentArticlesProxyController } from './admin-content-articles-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW = '2026-06-30T12:00:00.000Z';

function requestWithCtx(userId = 'usr_editor'): RequestWithContext {
  return {
    requestContext: {
      userId,
      mfaVerified: true,
      roles: [
        {
          name: 'content_editor',
          permissions: ['content:read', 'content:edit', 'content:publish'],
          scope: { type: 'global' },
        },
      ],
      tenantScope: { type: 'global' },
    },
    headers: { 'x-trace-id': 'tr_art_001', 'idempotency-key': 'idem_001' },
  } as unknown as RequestWithContext;
}

const VERSION = {
  id: 'ver_1',
  articleId: 'art_1',
  versionNo: 1,
  title: 'Welcoming the seasons',
  body: '# Hello\n\nA warm chef-prepared meal.',
  effectiveAt: null,
  createdBy: 'usr_editor',
  createdAt: NOW,
  updatedAt: NOW,
};

const ARTICLE = {
  id: 'art_1',
  slug: 'welcoming-the-seasons',
  status: 'draft' as const,
  title: 'Welcoming the seasons',
  categoryId: null,
  currentVersionId: null,
  newsletterSentAt: null,
  createdAt: NOW,
  updatedAt: NOW,
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

const DEFAULT_COMMENTS = {
  enabled: false,
  provider: 'disqus' as const,
  disqusIdentifier: null,
};

const DETAIL = { ...ARTICLE, versions: [VERSION], seo: NULL_SEO, comments: DEFAULT_COMMENTS };

const VALID_LIST_RESPONSE = { articles: [ARTICLE] };
const VALID_ARTICLE_RESPONSE = { article: ARTICLE };
const VALID_DETAIL_RESPONSE = { article: DETAIL };
const VALID_VERSION_RESPONSE = { version: VERSION };
const VALID_SEO_RESPONSE = { seo: { ...NULL_SEO, seoTitle: 'Best pie' } };
const VALID_COMMENTS_RESPONSE = {
  comments: { ...DEFAULT_COMMENTS, enabled: true, disqusIdentifier: 'blog-pie-guide' },
};

function buildController(stub: StubDownstreamClient): AdminContentArticlesProxyController {
  return new AdminContentArticlesProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminContentArticlesProxyController.list', () => {
  it('forwards the GET with an allow-listed query string', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);

    const response = await controller.list({ status: 'draft', limit: '25' }, requestWithCtx());

    expect(response.articles).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('content');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toContain('/api/v1/admin/content/articles?');
    expect(stub.lastOptions?.path).toContain('limit=25');
    expect(stub.lastOptions?.path).toContain('status=draft');
    expect(stub.lastOptions?.traceId).toBe('tr_art_001');
  });

  it('defaults the limit when no query is supplied', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await controller.list({}, requestWithCtx());
    expect(stub.lastOptions?.path).toContain('limit=50');
  });

  it('rejects a malformed query with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await expect(controller.list({ limit: '99999' }, requestWithCtx())).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.list({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws 502 when the downstream body violates the contract', async () => {
    const stub = new StubDownstreamClient(ok({ articles: [{ bogus: true }] }));
    const controller = buildController(stub);
    await expect(controller.list({}, requestWithCtx())).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('AdminContentArticlesProxyController.create', () => {
  it('forwards the POST with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_ARTICLE_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.create(
      { slug: 'welcoming-the-seasons', title: 'Welcoming the seasons' },
      'idem_001',
      requestWithCtx(),
    );
    expect(response.article.id).toBe('art_1');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/articles');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_001');
  });

  it('rejects a bad slug with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_ARTICLE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.create({ slug: 'Not A Slug', title: 'x' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

describe('AdminContentArticlesProxyController.detail', () => {
  it('forwards the GET to the detail path', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.detail('art_1', requestWithCtx());
    expect(response.article.versions).toHaveLength(1);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/articles/art_1');
  });

  it('url-encodes the articleId (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const controller = buildController(stub);
    await controller.detail('../help-categories', requestWithCtx());
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/articles/..%2Fhelp-categories');
  });

  it('passes a 404 through verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', status: 404, detail: 'gone' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(controller.detail('missing', requestWithCtx())).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('AdminContentArticlesProxyController.update', () => {
  it('forwards the PATCH with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_ARTICLE_RESPONSE));
    const controller = buildController(stub);
    await controller.update('art_1', { title: 'Renamed' }, 'idem_001', requestWithCtx());
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/articles/art_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_001');
  });

  it('rejects an empty patch with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_ARTICLE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.update('art_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

describe('AdminContentArticlesProxyController.updateComments', () => {
  it('forwards the PATCH to the comments path with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_COMMENTS_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.updateComments(
      'art_1',
      { enabled: true, disqusIdentifier: 'blog-pie-guide' },
      'idem_001',
      requestWithCtx(),
    );
    expect(response.comments.enabled).toBe(true);
    expect(response.comments.disqusIdentifier).toBe('blog-pie-guide');
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/articles/art_1/comments');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_001');
  });

  it('rejects an empty comments patch with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_COMMENTS_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.updateComments('art_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects an unknown provider with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_COMMENTS_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.updateComments('art_1', { provider: 'facebook' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

describe('AdminContentArticlesProxyController.updateSeo', () => {
  it('forwards the PATCH to the seo path with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_SEO_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.updateSeo(
      'art_1',
      { seoTitle: 'Best pie', canonicalUrl: 'https://tasteandsee.example/blog/pie' },
      'idem_001',
      requestWithCtx(),
    );
    expect(response.seo.seoTitle).toBe('Best pie');
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/articles/art_1/seo');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_001');
  });

  it('rejects an empty seo patch with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_SEO_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.updateSeo('art_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects a non-http canonical URL with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_SEO_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.updateSeo(
        'art_1',
        { canonicalUrl: 'javascript:alert(1)' },
        undefined,
        requestWithCtx(),
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

describe('AdminContentArticlesProxyController.appendVersion', () => {
  it('forwards the POST to the versions path with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_VERSION_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.appendVersion(
      'art_1',
      { title: 'Welcoming the seasons', body: '# Hello' },
      'idem_001',
      requestWithCtx(),
    );
    expect(response.version.versionNo).toBe(1);
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/articles/art_1/versions');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_001');
  });

  it('rejects an empty body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_VERSION_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.appendVersion('art_1', { title: 'x', body: '' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

describe('AdminContentArticlesProxyController.publish', () => {
  it('forwards the POST publish (empty body allowed) with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_ARTICLE_RESPONSE));
    const controller = buildController(stub);
    await controller.publish('art_1', 'ver_1', {}, 'idem_001', requestWithCtx());
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe(
      '/api/v1/admin/content/articles/art_1/versions/ver_1/publish',
    );
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_001');
  });

  it('forwards publish with an undefined body as an empty publish', async () => {
    const stub = new StubDownstreamClient(ok(VALID_ARTICLE_RESPONSE));
    const controller = buildController(stub);
    await controller.publish('art_1', 'ver_1', undefined, undefined, requestWithCtx());
    expect(stub.lastOptions?.method).toBe('POST');
  });

  it('passes a 409 already-published through verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'already live' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(
      controller.publish('art_1', 'ver_1', {}, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('maps a downstream timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const controller = buildController(stub);
    await expect(
      controller.publish('art_1', 'ver_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('maps a not_configured downstream to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'content' });
    const controller = buildController(stub);
    await expect(
      controller.publish('art_1', 'ver_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('maps a network_error downstream to 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'ECONNREFUSED' });
    const controller = buildController(stub);
    await expect(
      controller.publish('art_1', 'ver_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

const AUTHOR = {
  id: 'author_1',
  userId: 'usr_writer',
  displayName: 'Ada Writer',
  bio: null,
  photoAssetKey: null,
  socialLinks: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const VALID_ARTICLE_AUTHORS_RESPONSE = {
  authors: [{ role: 'primary' as const, sortOrder: 0, author: AUTHOR }],
};

describe('AdminContentArticlesProxyController byline (TS-283)', () => {
  it('forwards the GET authors read', async () => {
    const stub = new StubDownstreamClient(ok(VALID_ARTICLE_AUTHORS_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.listAuthors('art_1', requestWithCtx());
    expect(response.authors).toHaveLength(1);
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/articles/art_1/authors');
  });

  it('forwards the PUT set-authors with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_ARTICLE_AUTHORS_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.setAuthors(
      'art_1',
      { authors: [{ authorId: 'author_1', role: 'primary' }] },
      'idem_by_1',
      requestWithCtx(),
    );
    expect(response.authors).toHaveLength(1);
    expect(stub.lastOptions?.method).toBe('PUT');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/articles/art_1/authors');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_by_1');
  });

  it('rejects a malformed set-authors body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_ARTICLE_AUTHORS_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.setAuthors(
        'art_1',
        { authors: [{ authorId: 'a' }, { authorId: 'a' }] },
        undefined,
        requestWithCtx(),
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

describe('AdminContentArticlesProxyController.sendToNewsletter', () => {
  const VALID_NEWSLETTER_RESPONSE = { newsletterSentAt: NOW };

  it('forwards the POST newsletter send (empty body) with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_NEWSLETTER_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.sendToNewsletter('art_1', {}, 'idem_001', requestWithCtx());
    expect(response.newsletterSentAt).toBe(NOW);
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/articles/art_1/newsletter');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_001');
  });

  it('forwards an undefined body as an empty send', async () => {
    const stub = new StubDownstreamClient(ok(VALID_NEWSLETTER_RESPONSE));
    const controller = buildController(stub);
    await controller.sendToNewsletter('art_1', undefined, undefined, requestWithCtx());
    expect(stub.lastOptions?.method).toBe('POST');
  });

  it('passes a 409 already-sent through verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'already sent' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(
      controller.sendToNewsletter('art_1', {}, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 409 });
  });
});
