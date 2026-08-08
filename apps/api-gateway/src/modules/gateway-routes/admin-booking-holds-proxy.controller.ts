import {
  BadGatewayException,
  Controller,
  Get,
  GatewayTimeoutException,
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
  BookingHoldListResponseSchema,
  ListBookingHoldsQuerySchema,
  type BookingHoldListResponse,
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
 * Admin booking-hold BFF proxy (TS-304-followup-4; PRD §10.14,
 * PDD §16.1).
 *
 *   `GET /api/v1/admin/booking-holds?status=&incidentId=&subjectKind=&subjectId=&limit=&offset=`
 *     What is currently suspended by a trust & safety hold, since when,
 *     by which incident, and how much care that is interrupting.
 *
 * **Gated `trust_safety:read`, matching the downstream route.** The
 * hold lives in service-booking but the question belongs to the trust &
 * safety console — a hold exists because of an incident, and the reader
 * who needs it is the one deliberating on that incident. Gating it on a
 * booking permission would put the roster of who is under investigation
 * in front of every operator working the booking queue.
 *
 * **Deliberately read-only.** There is no proxy for placing or lifting
 * a hold because there is no downstream route to proxy: a hold is
 * placed by an incident and lifted by the committee closing it (TS-304).
 *
 * The query is parsed at the edge and the downstream URL re-serialised
 * from the parsed value, so `.strict()` and the
 * `subjectId`-requires-`subjectKind` refinement both bite here rather
 * than one hop later.
 *
 * **No idempotency key** — GET is naturally idempotent.
 */
@Controller('api/v1/admin/booking-holds')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminBookingHoldsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('trust_safety:read')
  async listHolds(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<BookingHoldListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ListBookingHoldsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Booking hold query failed validation.', parsed.error.issues);
    }

    const search = new URLSearchParams();
    search.set('status', parsed.data.status);
    for (const key of ['incidentId', 'subjectKind', 'subjectId'] as const) {
      const value = parsed.data[key];
      if (value !== undefined) search.set(key, value);
    }
    search.set('limit', String(parsed.data.limit));
    search.set('offset', String(parsed.data.offset));

    const result: DownstreamResult = await this.downstream.call({
      service: 'booking',
      path: `/api/v1/admin/booking-holds?${search.toString()}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, BookingHoldListResponseSchema, 'booking-holds', traceId);
  }
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
