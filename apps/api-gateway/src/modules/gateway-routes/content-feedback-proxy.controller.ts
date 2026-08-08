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
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ArticleFeedbackResponseSchema,
  ListRelatedArticlesQuerySchema,
  RelatedArticlesResponseSchema,
  SubmitArticleFeedbackRequestSchema,
  type ArticleFeedbackResponse,
  type ListRelatedArticlesQuery,
  type RelatedArticlesResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * End-user article-engagement BFF proxy (TS-287; PRD §10.10, §10.11; PDD §19.3).
 *
 *   PUT /api/v1/content/articles/:articleId/feedback  — cast / change my vote
 *   GET /api/v1/content/articles/:articleId/feedback  — aggregate + my vote
 *   GET /api/v1/content/articles/:articleId/related   — related articles
 *
 * Forwards to service-content's identical `/api/v1/content/articles/...` surface
 * at the SAME path. Unlike the admin authoring proxies (gated on `content:*`),
 * this is USER-FACING: `AccessTokenGuard` + `RateLimitGuard` ONLY (no
 * `PermissionGuard`) — any authenticated reader. The actor context propagates via
 * the signed trust-header envelope the `DownstreamHttpClient` mints, so
 * service-content keys the vote by the token's `userId`. The `PUT` forwards the
 * inbound `Idempotency-Key`. Sibling of the favourite-providers proxy.
 */
@Controller('api/v1/content/articles')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class ContentFeedbackProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Put(':articleId/feedback')
  @HttpCode(HttpStatus.OK)
  async submitFeedback(
    @Param('articleId') articleId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<ArticleFeedbackResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = SubmitArticleFeedbackRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Article feedback payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/content/articles/${encodeURIComponent(articleId)}/feedback`,
      method: 'PUT',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      ArticleFeedbackResponseSchema,
      'content-article-feedback-submit',
      traceId,
    );
  }

  @Get(':articleId/feedback')
  @HttpCode(HttpStatus.OK)
  async feedbackSummary(
    @Param('articleId') articleId: string,
    @Req() request: RequestWithContext,
  ): Promise<ArticleFeedbackResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/content/articles/${encodeURIComponent(articleId)}/feedback`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      ArticleFeedbackResponseSchema,
      'content-article-feedback-summary',
      traceId,
    );
  }

  @Get(':articleId/related')
  @HttpCode(HttpStatus.OK)
  async related(
    @Param('articleId') articleId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<RelatedArticlesResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ListRelatedArticlesQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Related-articles query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: buildRelatedPath(articleId, parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, RelatedArticlesResponseSchema, 'content-article-related', traceId);
  }
}

/**
 * Rebuild the downstream query string from the validated query — a
 * defence-in-depth allow-list so a smuggled param can't ride through.
 */
function buildRelatedPath(articleId: string, query: ListRelatedArticlesQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  return `/api/v1/content/articles/${encodeURIComponent(articleId)}/related?${params.toString()}`;
}

function badRequest(detail: string, issues: unknown): HttpException {
  return new HttpException(
    { type: 'about:blank', title: 'Bad Request', status: HttpStatus.BAD_REQUEST, detail, issues },
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
