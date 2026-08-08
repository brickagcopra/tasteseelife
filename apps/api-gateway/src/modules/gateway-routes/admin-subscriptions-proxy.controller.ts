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
  AdminSubscriptionDetailResponseSchema,
  AdminSubscriptionsListQuerySchema,
  AdminSubscriptionsListResponseSchema,
  type AdminSubscriptionDetailResponse,
  type AdminSubscriptionsListQuery,
  type AdminSubscriptionsListResponse,
} from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { SuperAdminRoleGuard } from '../../common/guards/admin-role.guard';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Admin subscriptions BFF proxies (TS-127 Slice 1).
 *
 *   GET /api/v1/admin/subscriptions
 *     Cursor-paginated search across the subscription service's
 *     subscriptions table. Forwards the allow-listed query params to
 *     service-subscription. Returns the same
 *     `AdminSubscriptionsListResponse` shape.
 *
 *   GET /api/v1/admin/subscriptions/:id
 *     Forward the path-param to service-subscription and return the
 *     `AdminSubscriptionDetailResponse`. 404 is forwarded verbatim from
 *     the downstream when the id does not resolve.
 *
 * Both endpoints sit behind three guards (in order):
 *   1. `AccessTokenGuard`    — verify the JWT + attach RequestContext.
 *   2. `SuperAdminRoleGuard` — require an active super_admin role.
 *   3. `RateLimitGuard`      — apply the default policy.
 *
 * The downstream service-subscription ALSO enforces the super_admin gate
 * (defence-in-depth) so a caller that bypasses the gateway and hits
 * service-subscription directly still fails at the service boundary.
 *
 * **Slice 1 scope.** Read-only. Mutations (comp / refund / extend-trial
 * / prorate / pause / resume admin overrides), plan-catalog edit, bulk
 * cohort operations, revenue-recognition reporting, manual dunning
 * recovery, audit-event emission, OTel + Prometheus, OpenAPI
 * registration, and the PermissionGuard lift all arrive in subsequent
 * TS-127 follow-ups. Their proxies (and any new write paths) slot in
 * alongside these two reads.
 *
 * Mirrors `AdminUsersProxyController` (TS-126 Slice 1) shape one-for-one
 * so the gateway-side patterns stay consistent across admin surfaces.
 */
@Controller('api/v1/admin/subscriptions')
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard, RateLimitGuard)
export class AdminSubscriptionsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AdminSubscriptionsListResponse> {
    const ctx = requireContext(request);
    const parsed = AdminSubscriptionsListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Admin subscriptions list query failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const downstreamPath = buildListPath(parsed.data);
    const result: DownstreamResult = await this.downstream.call({
      service: 'subscription',
      path: downstreamPath,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    return mapResult(
      result,
      AdminSubscriptionsListResponseSchema,
      'admin-subscriptions-list',
      extractTraceId(request),
    );
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async getById(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
  ): Promise<AdminSubscriptionDetailResponse> {
    const ctx = requireContext(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'subscription',
      path: `/api/v1/admin/subscriptions/${encodeURIComponent(id)}`,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    return mapResult(
      result,
      AdminSubscriptionDetailResponseSchema,
      'admin-subscription-detail',
      extractTraceId(request),
    );
  }
}

/**
 * Build the downstream list path from the contract-allow-listed query
 * fields. Defence-in-depth — only fields the schema accepted are
 * forwarded, so query-string smuggling can't reach the downstream.
 */
function buildListPath(query: AdminSubscriptionsListQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  if (query.customerGroup !== undefined) {
    params.set('customerGroup', query.customerGroup);
  }
  if (query.status !== undefined) params.set('status', query.status);
  if (query.planId !== undefined) params.set('planId', query.planId);
  if (query.customerId !== undefined) params.set('customerId', query.customerId);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  return `/api/v1/admin/subscriptions?${params.toString()}`;
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
          detail: `Downstream service-subscription returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-subscription returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-subscription did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-subscription is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure SUBSCRIPTION_SERVICE_BASE_URL.`,
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
