import {
  BadGatewayException,
  Body,
  Controller,
  GatewayTimeoutException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ArticleAuthorsResponseSchema,
  ArticleCommentsResponseSchema,
  ArticleDetailResponseSchema,
  ArticleResponseSchema,
  ArticleSeoResponseSchema,
  ArticleVersionResponseSchema,
  ArticlesListResponseSchema,
  CreateArticleRequestSchema,
  CreateArticleVersionRequestSchema,
  ListArticlesQuerySchema,
  PublishArticleVersionRequestSchema,
  SendArticleNewsletterRequestSchema,
  SendArticleNewsletterResponseSchema,
  SetArticleAuthorsRequestSchema,
  UpdateArticleCommentsRequestSchema,
  UpdateArticleRequestSchema,
  UpdateArticleSeoRequestSchema,
  type ArticleAuthorsResponse,
  type ArticleCommentsResponse,
  type ArticleDetailResponse,
  type ArticleResponse,
  type ArticleSeoResponse,
  type ArticleVersionResponse,
  type ArticlesListResponse,
  type ListArticlesQuery,
  type SendArticleNewsletterResponse,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Admin blog/CMS article-authoring BFF proxy (TS-281; PRD §10.10; PDD §19.1).
 *
 *   GET   /api/v1/admin/content/articles                                   — list
 *   POST  /api/v1/admin/content/articles                                   — create
 *   GET   /api/v1/admin/content/articles/:articleId                        — detail (+ versions)
 *   PATCH /api/v1/admin/content/articles/:articleId                        — metadata
 *   PATCH /api/v1/admin/content/articles/:articleId/seo                    — SEO metadata
 *   PATCH /api/v1/admin/content/articles/:articleId/comments               — comments config
 *   POST  /api/v1/admin/content/articles/:articleId/versions              — append version
 *   GET   /api/v1/admin/content/articles/:articleId/versions/:versionId   — single version
 *   POST  /api/v1/admin/content/articles/:articleId/versions/:versionId/publish — publish
 *
 * Forwards to service-content's identical `/api/v1/admin/content/articles`
 * surface (TS-284-followup-3) at the SAME path.
 *
 * **Authorisation.** All endpoints sit behind three guards (in order):
 * `AccessTokenGuard` → `PermissionGuard` → `RateLimitGuard`. The permission trio
 * mirrors service-content (PDD §19.1 / TS-284): `content:read` for the reads,
 * `content:edit` for create / metadata / append-version, `content:publish` for
 * the publish lever. service-content ALSO enforces the same gate (defence-in-
 * depth). The acting admin's identity propagates via the signed trust-header
 * envelope the `DownstreamHttpClient` mints (`actor: ctx`); it is never read from
 * the body.
 *
 * **Idempotency-Key.** The POST / PATCH proxies forward the inbound
 * `Idempotency-Key` header so a client-side retry collapses against
 * service-content's `@Idempotent()` cached response.
 *
 * Sibling of the TS-277b ad-creatives proxy.
 */
@Controller('api/v1/admin/content/articles')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminContentArticlesProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<ArticlesListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ListArticlesQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Article list query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: buildListPath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, ArticlesListResponseSchema, 'admin-content-articles-list', traceId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('content:edit')
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<ArticleResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = CreateArticleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Article create payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: '/api/v1/admin/content/articles',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, ArticleResponseSchema, 'admin-content-article-create', traceId);
  }

  @Get(':articleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  async detail(
    @Param('articleId') articleId: string,
    @Req() request: RequestWithContext,
  ): Promise<ArticleDetailResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/admin/content/articles/${encodeURIComponent(articleId)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, ArticleDetailResponseSchema, 'admin-content-article-detail', traceId);
  }

  @Patch(':articleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:edit')
  async update(
    @Param('articleId') articleId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<ArticleResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = UpdateArticleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Article metadata payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/admin/content/articles/${encodeURIComponent(articleId)}`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, ArticleResponseSchema, 'admin-content-article-update', traceId);
  }

  @Patch(':articleId/seo')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:edit')
  async updateSeo(
    @Param('articleId') articleId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<ArticleSeoResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = UpdateArticleSeoRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Article SEO payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/admin/content/articles/${encodeURIComponent(articleId)}/seo`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, ArticleSeoResponseSchema, 'admin-content-article-seo', traceId);
  }

  @Patch(':articleId/comments')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:edit')
  async updateComments(
    @Param('articleId') articleId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<ArticleCommentsResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = UpdateArticleCommentsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Article comments payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/admin/content/articles/${encodeURIComponent(articleId)}/comments`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      ArticleCommentsResponseSchema,
      'admin-content-article-comments',
      traceId,
    );
  }

  @Post(':articleId/versions')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('content:edit')
  async appendVersion(
    @Param('articleId') articleId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<ArticleVersionResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = CreateArticleVersionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Article version payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/admin/content/articles/${encodeURIComponent(articleId)}/versions`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      ArticleVersionResponseSchema,
      'admin-content-article-version',
      traceId,
    );
  }

  @Get(':articleId/versions/:versionId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  async version(
    @Param('articleId') articleId: string,
    @Param('versionId') versionId: string,
    @Req() request: RequestWithContext,
  ): Promise<ArticleVersionResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/admin/content/articles/${encodeURIComponent(articleId)}/versions/${encodeURIComponent(versionId)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      ArticleVersionResponseSchema,
      'admin-content-article-version-detail',
      traceId,
    );
  }

  @Post(':articleId/versions/:versionId/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:publish')
  async publish(
    @Param('articleId') articleId: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<ArticleResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = PublishArticleVersionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw badRequest('Article publish payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/admin/content/articles/${encodeURIComponent(articleId)}/versions/${encodeURIComponent(versionId)}/publish`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, ArticleResponseSchema, 'admin-content-article-publish', traceId);
  }

  @Post(':articleId/newsletter')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:publish')
  async sendToNewsletter(
    @Param('articleId') articleId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<SendArticleNewsletterResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = SendArticleNewsletterRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw badRequest('Article newsletter payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/admin/content/articles/${encodeURIComponent(articleId)}/newsletter`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      SendArticleNewsletterResponseSchema,
      'admin-content-article-newsletter',
      traceId,
    );
  }

  @Get(':articleId/authors')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  async listAuthors(
    @Param('articleId') articleId: string,
    @Req() request: RequestWithContext,
  ): Promise<ArticleAuthorsResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/admin/content/articles/${encodeURIComponent(articleId)}/authors`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      ArticleAuthorsResponseSchema,
      'admin-content-article-authors',
      traceId,
    );
  }

  @Put(':articleId/authors')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:edit')
  async setAuthors(
    @Param('articleId') articleId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<ArticleAuthorsResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = SetArticleAuthorsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Article authors payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/admin/content/articles/${encodeURIComponent(articleId)}/authors`,
      method: 'PUT',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      ArticleAuthorsResponseSchema,
      'admin-content-article-authors-set',
      traceId,
    );
  }
}

/**
 * Rebuild the downstream query string from the validated query — a
 * defence-in-depth allow-list so a smuggled param can't ride through to
 * service-content.
 */
function buildListPath(query: ListArticlesQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  if (query.status !== undefined) params.set('status', query.status);
  if (query.categoryId !== undefined) params.set('categoryId', query.categoryId);
  return `/api/v1/admin/content/articles?${params.toString()}`;
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

function requireContext(
  request: RequestWithContext,
): NonNullable<RequestWithContext['requestContext']> {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: HttpStatus.UNAUTHORIZED,
      detail: 'Authentication required.',
    });
  }
  return ctx;
}

function toBodyOrFallback(body: unknown, fallbackDetail: string): string | Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return { type: 'about:blank', title: 'Error', detail: fallbackDetail };
}

function extractTraceId(request: RequestWithContext): string | undefined {
  const candidates = [request.headers['x-trace-id'], request.headers['x-request-id']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}
