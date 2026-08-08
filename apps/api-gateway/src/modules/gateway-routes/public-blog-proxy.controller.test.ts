import 'reflect-metadata';

import { BadGatewayException, HttpException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { PublicBlogArticle, PublicBlogArticlesListResponse } from '@taste-and-see/contracts';
import type { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';
import { PublicBlogProxyController } from './public-blog-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const passthroughStore = {
  run: vi.fn((_frame: unknown, fn: () => unknown) => fn()),
} as unknown as TenantContextStore;

const ANON_REQUEST = { headers: { 'x-trace-id': 'tr_public_001' } } as never;

const ARTICLE: PublicBlogArticle = {
  slug: 'first-post',
  title: 'First post',
  body: '## Hello',
  publishedAt: '2026-06-01T09:00:00.000Z',
  category: null,
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

function makeController(result: DownstreamResult): {
  controller: PublicBlogProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  const controller = new PublicBlogProxyController(
    stub as unknown as DownstreamHttpClient,
    passthroughStore,
  );
  return { controller, stub };
}

describe('guard posture', () => {
  it('is rate-limited but carries NO AccessTokenGuard (anonymous by design)', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, PublicBlogProxyController) as unknown[];
    expect(guards).toEqual([RateLimitGuard]);
    expect(guards).not.toContain(AccessTokenGuard);
  });
});

describe('list', () => {
  it('proxies the index without an actor and forwards page + category', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: LIST,
      setCookies: [],
    });

    const response = await controller.list({ page: '2', category: 'stories' }, ANON_REQUEST);
    expect(response).toEqual(LIST);
    expect(stub.lastOptions?.service).toBe('content');
    expect(stub.lastOptions?.path).toBe('/api/v1/content/blog/articles?page=2&category=stories');
    expect(stub.lastOptions?.actor).toBeUndefined();
    expect(stub.lastOptions?.traceId).toBe('tr_public_001');
  });

  it('rejects a malformed query with 400 before any downstream call', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: LIST,
      setCookies: [],
    });
    await expect(controller.list({ page: '0' }, ANON_REQUEST)).rejects.toMatchObject({
      constructor: HttpException,
      status: 400,
    });
    expect(stub.lastOptions).toBeNull();
  });

  it('502s a downstream body that drifted off the public contract (leak firewall)', async () => {
    const { controller } = makeController({
      kind: 'ok',
      status: 200,
      body: { ...LIST, internalDrafts: [] },
      setCookies: [],
    });
    await expect(controller.list({}, ANON_REQUEST)).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('detail', () => {
  it('proxies a published article read without an actor', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { article: ARTICLE },
      setCookies: [],
    });

    const response = await controller.detail('first-post', ANON_REQUEST);
    expect(response.article.slug).toBe('first-post');
    expect(stub.lastOptions?.path).toBe('/api/v1/content/blog/articles/first-post');
    expect(stub.lastOptions?.actor).toBeUndefined();
    expect(passthroughStore.run).toHaveBeenCalledWith(
      { kind: 'exempt', reason: 'gateway-public-blog-read' },
      expect.any(Function),
    );
  });

  it('answers a malformed slug with the uniform 404 without a downstream round trip', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { article: ARTICLE },
      setCookies: [],
    });
    await expect(controller.detail('Not A Slug!', ANON_REQUEST)).rejects.toMatchObject({
      status: 404,
    });
    expect(stub.lastOptions).toBeNull();
  });

  it('passes the downstream 404 through untouched (draft/missing are uniform)', async () => {
    const notFoundBody = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: "No published article found for slug 'a-draft'.",
    };
    const { controller } = makeController({
      kind: 'client_error',
      status: 404,
      body: notFoundBody,
      setCookies: [],
    });
    await expect(controller.detail('a-draft', ANON_REQUEST)).rejects.toMatchObject({
      status: 404,
      response: notFoundBody,
    });
  });

  it('502s an article body carrying an internal field', async () => {
    const { controller } = makeController({
      kind: 'ok',
      status: 200,
      body: { article: { ...ARTICLE, createdBy: 'usr_staff' } },
      setCookies: [],
    });
    await expect(controller.detail('first-post', ANON_REQUEST)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('503s when the content route is not configured', async () => {
    const { controller } = makeController({ kind: 'not_configured', service: 'content' });
    await expect(controller.detail('first-post', ANON_REQUEST)).rejects.toMatchObject({
      status: 503,
    });
  });
});
