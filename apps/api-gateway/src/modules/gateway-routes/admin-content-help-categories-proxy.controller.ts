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
  CreateHelpCategoryRequestSchema,
  HelpCategoriesListResponseSchema,
  HelpCategoryResponseSchema,
  ListHelpCategoriesQuerySchema,
  UpdateHelpCategoryRequestSchema,
  type HelpCategoriesListResponse,
  type HelpCategoryResponse,
  type ListHelpCategoriesQuery,
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
 * Admin help-center category-tree BFF proxy (TS-281; PRD §10.11; PDD §19.3).
 *
 *   GET   /api/v1/admin/content/help-categories        — list (flat, sorted)
 *   POST  /api/v1/admin/content/help-categories        — create
 *   GET   /api/v1/admin/content/help-categories/:id    — detail
 *   PATCH /api/v1/admin/content/help-categories/:id    — update (name/sort/parent)
 *
 * Forwards to service-content's identical surface (TS-284-followup-3) at the
 * SAME path. `content:read` for the reads, `content:edit` for create / update;
 * service-content re-enforces the gate (defence-in-depth). The POST / PATCH
 * proxies forward the inbound `Idempotency-Key`. Sibling of the content-articles
 * proxy.
 */
@Controller('api/v1/admin/content/help-categories')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminContentHelpCategoriesProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<HelpCategoriesListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ListHelpCategoriesQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Help-category list query failed validation.', parsed.error.issues);
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
      HelpCategoriesListResponseSchema,
      'admin-content-help-categories-list',
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
  ): Promise<HelpCategoryResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = CreateHelpCategoryRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Help-category create payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: '/api/v1/admin/content/help-categories',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      HelpCategoryResponseSchema,
      'admin-content-help-category-create',
      traceId,
    );
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  async detail(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
  ): Promise<HelpCategoryResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/admin/content/help-categories/${encodeURIComponent(id)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      HelpCategoryResponseSchema,
      'admin-content-help-category-detail',
      traceId,
    );
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:edit')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<HelpCategoryResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = UpdateHelpCategoryRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Help-category update payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'content',
      path: `/api/v1/admin/content/help-categories/${encodeURIComponent(id)}`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      HelpCategoryResponseSchema,
      'admin-content-help-category-update',
      traceId,
    );
  }
}

function buildListPath(query: ListHelpCategoriesQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  if (query.parentId !== undefined) params.set('parentId', query.parentId);
  return `/api/v1/admin/content/help-categories?${params.toString()}`;
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
