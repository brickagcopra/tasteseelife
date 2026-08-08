import {
  BadGatewayException,
  Controller,
  GatewayTimeoutException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ListSearchRelevanceDailyResponseSchema,
  SearchRelevanceDayDetailResponseSchema,
  SearchRelevanceDetailQuerySchema,
  SearchRelevanceRangeQuerySchema,
  type ListSearchRelevanceDailyResponse,
  type SearchRelevanceDayDetailResponse,
  type SearchRelevanceDetailQuery,
  type SearchRelevanceRangeQuery,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { SuperAdminRoleGuard } from '../../common/guards/admin-role.guard';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Search-relevance dashboard BFF proxy (TS-217a; PRD §10.1, PDD §23.1/§23.2).
 *
 *   GET /api/v1/admin/analytics/search-relevance/summary?from=&to=
 *   GET /api/v1/admin/analytics/search-relevance/detail?date=
 *
 * Forwards the dashboard reads to service-analytics's
 * `AdminSearchRelevanceController`. Three-guard stack
 * (`AccessTokenGuard` → `SuperAdminRoleGuard` → `RateLimitGuard`);
 * defence-in-depth — the downstream service also enforces super_admin. The
 * query is re-validated at the gateway boundary (the common-case typo gets an
 * RFC-7807 error keyed to the gateway path rather than a downstream
 * round-trip). Mirrors `AdminSaasMetricsProxyController`.
 */
@Controller('api/v1/admin/analytics/search-relevance')
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard, RateLimitGuard)
export class AdminSearchRelevanceProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get('summary')
  @HttpCode(HttpStatus.OK)
  async listSummaries(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<ListSearchRelevanceDailyResponse> {
    const ctx = requireContext(request);
    const parsed = SearchRelevanceRangeQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest(
        'Admin search-relevance range query failed validation.',
        parsed.error.issues,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'analytics',
      path: buildSummaryPath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    return mapResult(
      result,
      ListSearchRelevanceDailyResponseSchema,
      'admin-search-relevance-summary',
      extractTraceId(request),
    );
  }

  @Get('detail')
  @HttpCode(HttpStatus.OK)
  async getDetail(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<SearchRelevanceDayDetailResponse> {
    const ctx = requireContext(request);
    const parsed = SearchRelevanceDetailQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest(
        'Admin search-relevance detail query failed validation.',
        parsed.error.issues,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'analytics',
      path: buildDetailPath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    return mapResult(
      result,
      SearchRelevanceDayDetailResponseSchema,
      'admin-search-relevance-detail',
      extractTraceId(request),
    );
  }
}

function buildSummaryPath(query: SearchRelevanceRangeQuery): string {
  const params = new URLSearchParams();
  if (query.from !== undefined) params.set('from', query.from);
  if (query.to !== undefined) params.set('to', query.to);
  const qs = params.toString();
  const base = '/api/v1/admin/analytics/search-relevance/summary';
  return qs.length > 0 ? `${base}?${qs}` : base;
}

function buildDetailPath(query: SearchRelevanceDetailQuery): string {
  const params = new URLSearchParams({ date: query.date });
  return `/api/v1/admin/analytics/search-relevance/detail?${params.toString()}`;
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
          detail: `Downstream service-analytics returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-analytics returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-analytics did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-analytics is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure ANALYTICS_SERVICE_BASE_URL.`,
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
