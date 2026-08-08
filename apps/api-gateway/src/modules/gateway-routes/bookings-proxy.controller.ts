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
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  BookingResponseSchema,
  BookingsListResponseSchema,
  CreateConciergeBookingRequestSchema,
  FamilyVisitsDashboardQuerySchema,
  FamilyVisitsDashboardResponseSchema,
  ListBookingsQuerySchema,
  type BookingResponse,
  type BookingsListResponse,
  type FamilyVisitsDashboardQuery,
  type FamilyVisitsDashboardResponse,
  type ListBookingsQuery,
} from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Bookings BFF proxies (TS-125). Three surfaces:
 *
 *   - `POST /api/v1/bookings/concierge-request`
 *     Forward the family-portal price-free booking-request body to
 *     service-booking's concierge endpoint. The downstream derives
 *     platform-default pricing + commission and creates the booking
 *     in `pending`.
 *
 *   - `GET  /api/v1/bookings?householdId=...`
 *     List bookings for a single household (cursor pagination).
 *
 *   - `GET  /api/v1/bookings/dashboard/me`
 *     Family peace-of-mind dashboard read (TS-230) — the windowed
 *     upcoming list + the cursor-paginated completed-visit history
 *     with visit-note summaries. The household is resolved from the
 *     token `tenantScope` downstream (no id on the wire); a non-
 *     household actor receives the downstream 400 verbatim.
 *
 *   - `GET  /api/v1/bookings/:id`
 *     Read a single booking by id.
 *
 * Authenticated + default-rate-limited. Failure-mapping is the same
 * shape as the other proxies in this module.
 *
 * The status-transition endpoint (PATCH /api/v1/bookings/:id/status)
 * is intentionally NOT proxied here in Phase 1 — concierge fulfilment
 * uses admin tooling (TS-128); family self-service cancel lives on
 * `/bookings/[id]` and lands as TS-125-followup-4 once the cancel UX
 * is wired.
 */
@Controller('api/v1/bookings')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class BookingsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Post('concierge-request')
  @HttpCode(HttpStatus.CREATED)
  async createConciergeRequest(
    @Body() body: unknown,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<BookingResponse> {
    const ctx = requireContext(request);
    const parsed = CreateConciergeBookingRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Concierge booking-request payload failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'booking',
      path: '/api/v1/bookings/concierge-request',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });

    return mapResult(
      result,
      BookingResponseSchema,
      'concierge-booking-request',
      extractTraceId(request),
    );
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<BookingsListResponse> {
    const ctx = requireContext(request);
    const parsed = ListBookingsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Bookings list query failed validation.',
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

    return mapResult(result, BookingsListResponseSchema, 'bookings-list', extractTraceId(request));
  }

  @Get('dashboard/me')
  @HttpCode(HttpStatus.OK)
  async getMyDashboard(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<FamilyVisitsDashboardResponse> {
    const ctx = requireContext(request);
    const parsed = FamilyVisitsDashboardQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Family dashboard query failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'booking',
      path: buildDashboardPath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    return mapResult(
      result,
      FamilyVisitsDashboardResponseSchema,
      'bookings-dashboard-me',
      extractTraceId(request),
    );
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async getById(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
  ): Promise<BookingResponse> {
    const ctx = requireContext(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'booking',
      path: `/api/v1/bookings/${encodeURIComponent(id)}`,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    return mapResult(result, BookingResponseSchema, 'booking-get', extractTraceId(request));
  }
}

/**
 * Build the downstream list path from the contract-allow-listed query
 * fields. Defence-in-depth — only fields the schema accepted are
 * forwarded, so query-string smuggling can't reach the downstream.
 */
function buildListPath(query: ListBookingsQuery): string {
  const params = new URLSearchParams();
  params.set('householdId', query.householdId);
  params.set('limit', String(query.limit));
  if (query.cursor !== undefined) {
    params.set('cursor', query.cursor);
  }
  return `/api/v1/bookings?${params.toString()}`;
}

/**
 * Build the downstream dashboard path from the contract-allow-listed
 * query fields (TS-230). `householdId` is deliberately NOT forwarded —
 * the downstream resolves it from the token `tenantScope`. Only the
 * fields the schema accepted ride along, so query-string smuggling
 * can't reach the downstream.
 */
function buildDashboardPath(query: FamilyVisitsDashboardQuery): string {
  const params = new URLSearchParams();
  params.set('windowDays', String(query.windowDays));
  params.set('historyLimit', String(query.historyLimit));
  if (query.seniorId !== undefined) {
    params.set('seniorId', query.seniorId);
  }
  if (query.historyCursor !== undefined) {
    params.set('historyCursor', query.historyCursor);
  }
  return `/api/v1/bookings/dashboard/me?${params.toString()}`;
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
