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
  ListSaasMetricsResponseSchema,
  SaasMetricsRangeQuerySchema,
  type ListSaasMetricsResponse,
  type SaasMetricsRangeQuery,
} from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { SuperAdminRoleGuard } from '../../common/guards/admin-role.guard';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * SaaS-metrics dashboard BFF proxy (TS-266; PRD §10.1, PDD §23.2).
 *
 *   GET /api/v1/admin/accounting/saas-metrics?from=&to=
 *
 * Forwards the date-range read to service-accounting's
 * `AdminSaasMetricsController`. Three-guard stack
 * (`AccessTokenGuard` → `SuperAdminRoleGuard` → `RateLimitGuard`);
 * defence-in-depth — the downstream service also enforces super_admin.
 * The query is re-validated at the gateway boundary (the common-case
 * typo gets an RFC-7807 error keyed to the gateway path rather than a
 * downstream round-trip). Mirrors `AdminTrialBalanceProxyController`.
 */
@Controller('api/v1/admin/accounting/saas-metrics')
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard, RateLimitGuard)
export class AdminSaasMetricsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<ListSaasMetricsResponse> {
    const ctx = requireContext(request);
    const parsed = SaasMetricsRangeQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Admin SaaS-metrics range query failed validation.',
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
      ListSaasMetricsResponseSchema,
      'admin-saas-metrics',
      extractTraceId(request),
    );
  }
}

function buildPath(query: SaasMetricsRangeQuery): string {
  const params = new URLSearchParams();
  if (query.from !== undefined) params.set('from', query.from);
  if (query.to !== undefined) params.set('to', query.to);
  const qs = params.toString();
  return qs.length > 0
    ? `/api/v1/admin/accounting/saas-metrics?${qs}`
    : '/api/v1/admin/accounting/saas-metrics';
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
