import {
  BadGatewayException,
  Controller,
  GatewayTimeoutException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  AdminPeriodEventsListQuerySchema,
  AdminPeriodEventsListResponseSchema,
  type AdminPeriodEventsListQuery,
  type AdminPeriodEventsListResponse,
} from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { SuperAdminRoleGuard } from '../../common/guards/admin-role.guard';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Per-period lifecycle events BFF proxy (TS-129 Slice 1).
 *
 *   GET /api/v1/admin/periods/:periodName/events?cursor=&limit=
 *
 * Three-guard stack (`AccessTokenGuard` → `SuperAdminRoleGuard` →
 * `RateLimitGuard`). Defence-in-depth — the downstream also enforces
 * super_admin. 404 from the downstream (unknown periodName) is
 * forwarded verbatim.
 */
@Controller('api/v1/admin/periods')
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard, RateLimitGuard)
export class AdminPeriodEventsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get(':periodName/events')
  @HttpCode(HttpStatus.OK)
  async list(
    @Param('periodName') periodName: string,
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AdminPeriodEventsListResponse> {
    const ctx = requireContext(request);
    const parsed = AdminPeriodEventsListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Admin period-events list query failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const downstreamPath = buildPath(periodName, parsed.data);
    const result: DownstreamResult = await this.downstream.call({
      service: 'accounting',
      path: downstreamPath,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    return mapResult(
      result,
      AdminPeriodEventsListResponseSchema,
      'admin-period-events',
      extractTraceId(request),
    );
  }
}

function buildPath(periodName: string, query: AdminPeriodEventsListQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  return `/api/v1/admin/periods/${encodeURIComponent(periodName)}/events?${params.toString()}`;
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
          detail: `Downstream service-accounting returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-accounting returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-accounting did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-accounting is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure ACCOUNTING_SERVICE_BASE_URL.`,
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
