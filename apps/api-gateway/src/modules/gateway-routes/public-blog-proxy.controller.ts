import {
  BadGatewayException,
  Controller,
  GatewayTimeoutException,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  CONTENT_ARTICLE_SLUG_MAX_LENGTH,
  CONTENT_ARTICLE_SLUG_REGEX,
  ListPublicBlogArticlesQuerySchema,
  PublicBlogArticleResponseSchema,
  PublicBlogArticlesListResponseSchema,
  type ListPublicBlogArticlesQuery,
  type PublicBlogArticleResponse,
  type PublicBlogArticlesListResponse,
} from '@taste-and-see/contracts';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { RateLimit } from '../rate-limit/decorators/rate-limit.decorator';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * PUBLIC blog proxy (TS-282-followup-3) — fronts service-content's anonymous
 * published-articles projection for the web-marketing `/blog` pages.
 *
 *   GET /api/v1/content/blog/articles        — published index. No auth.
 *   GET /api/v1/content/blog/articles/:slug  — one published article. No auth.
 *
 * **Anonymous by design** — `RateLimitGuard` ONLY (the `AuthProxyController`
 * public-route posture): no `AccessTokenGuard`, no `PermissionGuard`, and the
 * downstream call carries NO `actor` (there is no trust envelope to build).
 * The rate-limit actor key falls back to the client IP for anonymous callers.
 *
 * **Second line of defense.** Responses are parse-checked against the STRICT
 * public contracts — if the downstream body ever drifts (an internal field, a
 * draft leaking), the gateway answers 502 rather than forwarding the leak.
 *
 * **Caching.** Static `Cache-Control` mirrors the downstream policy so CDNs /
 * the web-marketing ISR fetch can cache; the gateway itself stays stateless.
 *
 * **Tenant-scoping.** Handlers run with no authenticated context; bodies wrap
 * in `runWithoutTenantContext(..., 'gateway-public-blog-read', ...)` for parity
 * with the auth-proxy public handlers (the gateway has no Prisma — this is the
 * defence-in-depth shape of the platform rollout).
 */
@Controller('api/v1/content/blog')
@UseGuards(RateLimitGuard)
export class PublicBlogProxyController {
  constructor(
    private readonly downstream: DownstreamHttpClient,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  @Get('articles')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ policy: 'default' })
  @Header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: Request,
  ): Promise<PublicBlogArticlesListResponse> {
    return runWithoutTenantContext(this.tenantStore, 'gateway-public-blog-read', async () => {
      const traceId = extractTraceId(request);
      const parsed = ListPublicBlogArticlesQuerySchema.safeParse(query);
      if (!parsed.success) {
        throw badRequest('Blog list query failed validation.', parsed.error.issues);
      }

      const result: DownstreamResult = await this.downstream.call({
        service: 'content',
        path: buildListPath(parsed.data),
        method: 'GET',
        traceId,
      });

      return mapResult(result, PublicBlogArticlesListResponseSchema, 'public-blog-list', traceId);
    });
  }

  @Get('articles/:slug')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ policy: 'default' })
  @Header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
  async detail(
    @Param('slug') slug: string,
    @Req() request: Request,
  ): Promise<PublicBlogArticleResponse> {
    return runWithoutTenantContext(this.tenantStore, 'gateway-public-blog-read', async () => {
      const traceId = extractTraceId(request);
      // A malformed slug can never resolve — answer the same uniform 404 the
      // downstream gives a missing/draft slug (no shape oracle), without
      // spending a downstream round trip on it.
      if (
        slug.length === 0 ||
        slug.length > CONTENT_ARTICLE_SLUG_MAX_LENGTH ||
        !CONTENT_ARTICLE_SLUG_REGEX.test(slug)
      ) {
        throw publishedArticleNotFound(slug);
      }

      const result: DownstreamResult = await this.downstream.call({
        service: 'content',
        path: `/api/v1/content/blog/articles/${encodeURIComponent(slug)}`,
        method: 'GET',
        traceId,
      });

      return mapResult(result, PublicBlogArticleResponseSchema, 'public-blog-detail', traceId);
    });
  }
}

function buildListPath(query: ListPublicBlogArticlesQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  if (query.category !== undefined) params.set('category', query.category);
  return `/api/v1/content/blog/articles?${params.toString()}`;
}

function publishedArticleNotFound(slug: string): HttpException {
  return new HttpException(
    {
      type: 'about:blank',
      title: 'Not Found',
      status: HttpStatus.NOT_FOUND,
      detail: `No published article found for slug '${slug.slice(0, CONTENT_ARTICLE_SLUG_MAX_LENGTH)}'.`,
    },
    HttpStatus.NOT_FOUND,
  );
}

function badRequest(detail: string, issues: unknown): HttpException {
  return new HttpException(
    {
      type: 'about:blank',
      title: 'Bad Request',
      status: HttpStatus.BAD_REQUEST,
      detail,
      issues,
    },
    HttpStatus.BAD_REQUEST,
  );
}

function mapResult<TResponse>(
  result: DownstreamResult,
  schema: {
    safeParse: (input: unknown) => { success: true; data: TResponse } | { success: false };
  },
  surface: string,
  traceId: string | undefined,
): TResponse {
  switch (result.kind) {
    case 'ok': {
      const parsed = schema.safeParse(result.body);
      if (!parsed.success) {
        throw new BadGatewayException({
          type: 'about:blank',
          title: 'Bad Gateway',
          status: HttpStatus.BAD_GATEWAY,
          detail: `Downstream service-content returned a body that does not conform to the ${surface} contract.`,
          ...(traceId !== undefined && { traceId }),
        });
      }
      return parsed.data;
    }
    case 'client_error': {
      const body = toBodyOrFallback(result.body, 'Downstream client error.');
      throw new HttpException(body, result.status);
    }
    case 'server_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-content returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-content did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-content is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure CONTENT_SERVICE_BASE_URL.`,
        ...(traceId !== undefined && { traceId }),
      });
    }
  }
}

function toBodyOrFallback(body: unknown, fallbackDetail: string): string | Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return { type: 'about:blank', title: 'Error', detail: fallbackDetail };
}

function extractTraceId(request: Request): string | undefined {
  const candidates = [request.headers['x-trace-id'], request.headers['x-request-id']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}
