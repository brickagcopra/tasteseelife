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
  AdminPausedDeferredRevenueQuerySchema,
  AdminPausedDeferredRevenueResponseSchema,
  type AdminPausedDeferredRevenueQuery,
  type AdminPausedDeferredRevenueResponse,
} from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { SuperAdminRoleGuard } from '../../common/guards/admin-role.guard';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Paused deferred-revenue queue BFF proxy
 * (TS-042-followup-3b2-followup-2a).
 *
 *   GET /api/v1/admin/deferred-revenue/paused?limit=&asOf=
 *
 * Same three-guard stack as the other accounting admin proxies
 * (`AccessTokenGuard` → `SuperAdminRoleGuard` → `RateLimitGuard`), with
 * service-accounting enforcing super_admin again downstream.
 *
 * **Response re-validation earns its keep here.** The downstream body
 * carries an uncapped `summary.pausedCount` beside a capped `balances`
 * array; a drift that let the two blur — a nextCursor sneaking in, a count
 * turning into the page length — would turn "how much revenue is stranded"
 * into a smaller number that still looks like an answer. Drift is a 502.
 */
@Controller('api/v1/admin/deferred-revenue/paused')
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard, RateLimitGuard)
export class AdminDeferredRevenueProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async listPaused(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AdminPausedDeferredRevenueResponse> {
    const ctx = requireContext(request);
    const parsed = AdminPausedDeferredRevenueQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Admin paused deferred-revenue query failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'accounting',
      path: buildPath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    return mapResult(
      result,
      AdminPausedDeferredRevenueResponseSchema,
      'admin-paused-deferred-revenue',
      extractTraceId(request),
    );
  }
}

function buildPath(query: AdminPausedDeferredRevenueQuery): string {
  const params = new URLSearchParams();
  // `limit` always forwarded: the schema defaults it, and forwarding the
  // resolved value keeps the gateway's page size and the service's from
  // drifting apart if either default ever changes.
  params.set('limit', String(query.limit));
  if (query.asOf !== undefined) params.set('asOf', query.asOf);
  return `/api/v1/admin/deferred-revenue/paused?${params.toString()}`;
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
