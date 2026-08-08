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
  AdminBookingDetailResponseSchema,
  AdminBookingsListQuerySchema,
  AdminBookingsListResponseSchema,
  type AdminBookingDetailResponse,
  type AdminBookingsListQuery,
  type AdminBookingsListResponse,
} from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { SuperAdminRoleGuard } from '../../common/guards/admin-role.guard';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Admin bookings BFF proxies (TS-128 Slice 1).
 *
 *   GET /api/v1/admin/bookings
 *     Cursor-paginated search across the booking service's bookings
 *     table. Forwards the allow-listed query params to service-booking.
 *     Returns the same `AdminBookingsListResponse` shape.
 *
 *   GET /api/v1/admin/bookings/:id
 *     Forward the path-param to service-booking and return the
 *     `AdminBookingDetailResponse`. 404 is forwarded verbatim from the
 *     downstream when the id does not resolve.
 *
 * Both endpoints sit behind three guards (in order):
 *   1. `AccessTokenGuard`    — verify the JWT + attach RequestContext.
 *   2. `SuperAdminRoleGuard` — require an active super_admin role.
 *   3. `RateLimitGuard`      — apply the default policy.
 *
 * The downstream service-booking ALSO enforces the super_admin gate
 * (defence-in-depth) so a caller that bypasses the gateway and hits
 * service-booking directly still fails at the service boundary.
 *
 * **Slice 1 scope.** Read-only. Mutations (manual concierge booking
 * creation, cancel/refund, dispute open/resolve), provider tier +
 * commission management, featured-placement scheduling, service-catalog
 * management, audit-event emission, Playwright E2E, OTel + Prometheus,
 * and OpenAPI generator registration all arrive in subsequent TS-128
 * follow-ups. Their proxies (and any new write paths) slot in alongside
 * these two reads.
 *
 * Mirrors `AdminSubscriptionsProxyController` (TS-127 Slice 1) shape
 * one-for-one so the gateway-side patterns stay consistent across admin
 * surfaces.
 */
@Controller('api/v1/admin/bookings')
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard, RateLimitGuard)
export class AdminBookingsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AdminBookingsListResponse> {
    const ctx = requireContext(request);
    const parsed = AdminBookingsListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Admin bookings list query failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const downstreamPath = buildListPath(parsed.data);
    const result: DownstreamResult = await this.downstream.call({
      service: 'booking',
      path: downstreamPath,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    return mapResult(
      result,
      AdminBookingsListResponseSchema,
      'admin-bookings-list',
      extractTraceId(request),
    );
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async getById(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
  ): Promise<AdminBookingDetailResponse> {
    const ctx = requireContext(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'booking',
      path: `/api/v1/admin/bookings/${encodeURIComponent(id)}`,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    return mapResult(
      result,
      AdminBookingDetailResponseSchema,
      'admin-booking-detail',
      extractTraceId(request),
    );
  }
}

/**
 * Build the downstream list path from the contract-allow-listed query
 * fields. Defence-in-depth — only fields the schema accepted are
 * forwarded, so query-string smuggling can't reach the downstream.
 */
function buildListPath(query: AdminBookingsListQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  if (query.householdId !== undefined) params.set('householdId', query.householdId);
  if (query.providerId !== undefined) params.set('providerId', query.providerId);
  if (query.seniorId !== undefined) params.set('seniorId', query.seniorId);
  if (query.serviceKind !== undefined) params.set('serviceKind', query.serviceKind);
  if (query.status !== undefined) params.set('status', query.status);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  return `/api/v1/admin/bookings?${params.toString()}`;
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
          detail: `Downstream service-booking returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-booking returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-booking did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-booking is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure BOOKING_SERVICE_BASE_URL.`,
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
