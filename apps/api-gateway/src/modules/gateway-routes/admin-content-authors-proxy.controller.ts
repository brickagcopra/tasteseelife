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
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ContentAuthorResponseSchema,
  ContentAuthorsListResponseSchema,
  CreateContentAuthorRequestSchema,
  ListContentAuthorsQuerySchema,
  UpdateContentAuthorRequestSchema,
  type ContentAuthorResponse,
  type ContentAuthorsListResponse,
  type ListContentAuthorsQuery,
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
 * Admin author-profile CMS BFF proxy (TS-283; PRD §10.10; PDD §19.1).
 *
 *   GET   /api/v1/admin/content/authors             — list
 *   POST  /api/v1/admin/content/authors             — create
 *   GET   /api/v1/admin/content/authors/:authorId   — detail
 *   PATCH /api/v1/admin/content/authors/:authorId   — update
 *
 * Forwards to service-content's identical surface (TS-283) at the SAME path. The
 * article-byline sub-resource (`/articles/:articleId/authors`) lives on the
 * articles proxy. Permission trio mirrors service-content: `content:read` for the
 * reads, `content:edit` for create/update. service-content re-enforces the gate
 * (defence-in-depth). Idempotency-Key is forwarded on writes. Sibling of the
 * TS-281 articles proxy.
 */
@Controller('api/v1/admin/content/authors')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminContentAuthorsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<ContentAuthorsListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ListContentAuthorsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Author list query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: buildListPath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      ContentAuthorsListResponseSchema,
      'admin-content-authors-list',
      traceId,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('content:edit')
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<ContentAuthorResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = CreateContentAuthorRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Author create payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: '/api/v1/admin/content/authors',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, ContentAuthorResponseSchema, 'admin-content-author-create', traceId);
  }

  @Get(':authorId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  async detail(
    @Param('authorId') authorId: string,
    @Req() request: RequestWithContext,
  ): Promise<ContentAuthorResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/admin/content/authors/${encodeURIComponent(authorId)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, ContentAuthorResponseSchema, 'admin-content-author-detail', traceId);
  }

  @Patch(':authorId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:edit')
  async update(
    @Param('authorId') authorId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<ContentAuthorResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = UpdateContentAuthorRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Author update payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/admin/content/authors/${encodeURIComponent(authorId)}`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, ContentAuthorResponseSchema, 'admin-content-author-update', traceId);
  }
}

/** Rebuild the downstream query string from the validated query (allow-list). */
function buildListPath(query: ListContentAuthorsQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  return `/api/v1/admin/content/authors?${params.toString()}`;
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
