import {
  BadGatewayException,
  Body,
  Controller,
  GatewayTimeoutException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  AcceptBookingRequestSchema,
  BookingResponseSchema,
  DeclineBookingRequestSchema,
  BookingCheckInsListResponseSchema,
  RecordBookingCheckInRequestSchema,
  RecordBookingCheckInResponseSchema,
  type BookingResponse,
  type BookingCheckInsListResponse,
  type RecordBookingCheckInResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import type { Request } from 'express';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Booking-lifecycle BFF proxies (TS-505d-prep).
 *
 * **Why this controller exists.** Before it, `POST
 * /api/v1/bookings/concierge-request` was the *only* non-GET call the gateway
 * made to service-booking — verified by enumerating every
 * `service: 'booking'` call in this module. A visit could be requested and
 * read, and then nothing could ever happen to it: no provider could accept
 * it, no one could start it, and **no booking could ever be completed, so no
 * commission was ever recognised and no provider was ever paid.** The
 * lifecycle endpoints all existed on service-booking, fully tested, and were
 * unreachable from every client on the platform. Found while premise-checking
 * TS-505d, which needs a completed booking and could not produce one.
 *
 * **The four routes are the provider's own.** A visit moves
 * `pending → confirmed → in_progress → completed`, and the actor for every
 * one of those steps is the assigned provider: they accept the request, they
 * arrive, they leave. That is why this slice is the provider surface and not
 * the concierge one — `PATCH /api/v1/bookings/:id/status` (an operator
 * confirming or cancelling on someone's behalf) is a different actor with a
 * different authorisation question, and is deliberately still not proxied
 * (see `bookings-proxy.controller.ts`, and TS-125-followup-4 for the family
 * cancel).
 *
 *   - `POST /api/v1/bookings/:id/accept`            — pending → confirmed
 *   - `POST /api/v1/bookings/:id/decline`           — pending → declined
 *   - `POST /api/v1/bookings/:bookingId/check-ins`  — `check_in`  → in_progress
 *                                                     `check_out` → completed
 *   - `GET  /api/v1/bookings/:bookingId/check-ins`  — the visit's own record
 *
 * **Row-level authorisation stays downstream.** service-booking gates each of
 * these on the actor being a participant; the gateway forwards the verified
 * actor envelope and does not re-decide. A downstream 403 is passed through
 * verbatim by `mapResult`.
 *
 * **`Idempotency-Key` is forwarded on all three writes.** Each downstream
 * route wears `@Idempotent()` (CLAUDE.md §3.3), and these are the calls a
 * provider's phone makes from a doorstep on a bad connection — a retried
 * check-out that posted a second completion would post a second journal.
 * Dropping the header here would leave the downstream's replay cache with
 * nothing to key on, which is a silently disabled safety feature rather than
 * a visible one.
 */
@Controller('api/v1/bookings')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class BookingLifecycleProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestWithContext,
  ): Promise<BookingResponse> {
    const parsed = parseOrThrow(AcceptBookingRequestSchema, body ?? {}, 'Accept');
    return this.forwardWrite(request, `/api/v1/bookings/${encodeURIComponent(id)}/accept`, parsed, {
      schema: BookingResponseSchema,
      surface: 'booking-accept',
    });
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  async decline(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestWithContext,
  ): Promise<BookingResponse> {
    const parsed = parseOrThrow(DeclineBookingRequestSchema, body ?? {}, 'Decline');
    return this.forwardWrite(
      request,
      `/api/v1/bookings/${encodeURIComponent(id)}/decline`,
      parsed,
      {
        schema: BookingResponseSchema,
        surface: 'booking-decline',
      },
    );
  }

  @Post(':bookingId/check-ins')
  @HttpCode(HttpStatus.CREATED)
  async recordCheckIn(
    @Param('bookingId') bookingId: string,
    @Body() body: unknown,
    @Req() request: RequestWithContext,
  ): Promise<RecordBookingCheckInResponse> {
    const parsed = parseOrThrow(RecordBookingCheckInRequestSchema, body, 'Check-in');
    return this.forwardWrite(
      request,
      `/api/v1/bookings/${encodeURIComponent(bookingId)}/check-ins`,
      parsed,
      { schema: RecordBookingCheckInResponseSchema, surface: 'booking-check-in' },
    );
  }

  @Get(':bookingId/check-ins')
  @HttpCode(HttpStatus.OK)
  async listCheckIns(
    @Param('bookingId') bookingId: string,
    @Req() request: RequestWithContext,
  ): Promise<BookingCheckInsListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'booking',
      path: `/api/v1/bookings/${encodeURIComponent(bookingId)}/check-ins`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, BookingCheckInsListResponseSchema, 'booking-check-ins-list', traceId);
  }

  /**
   * The shared write path. All three writes differ only in path, body schema
   * and response schema — factoring it here keeps the actor, the trace id and
   * the `Idempotency-Key` from being forwarded on two routes and forgotten on
   * the third.
   */
  private async forwardWrite<TResponse>(
    request: RequestWithContext,
    path: string,
    body: unknown,
    response: {
      readonly schema: {
        safeParse: (input: unknown) => { success: true; data: TResponse } | { success: false };
      };
      readonly surface: string;
    },
  ): Promise<TResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);
    const idempotencyKey = readIdempotencyKey(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'booking',
      path,
      method: 'POST',
      body,
      actor: ctx,
      idempotencyKey,
      traceId,
    });

    return mapResult(result, response.schema, response.surface, traceId);
  }
}

function parseOrThrow<T>(
  schema: {
    safeParse: (
      input: unknown,
    ) => { success: true; data: T } | { success: false; error: { issues: unknown } };
  },
  body: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpException(
      {
        type: 'about:blank',
        title: 'Bad Request',
        status: HttpStatus.BAD_REQUEST,
        detail: `${label} payload failed validation.`,
        issues: parsed.error.issues,
      },
      HttpStatus.BAD_REQUEST,
    );
  }
  return parsed.data;
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
      // Passed through verbatim: the downstream owns the row-level decision
      // (403), the state machine (409) and existence (404), and re-labelling
      // any of them here would make the gateway the second place those rules
      // are written down.
      throw new HttpException(
        toBodyOrFallback(result.body, 'Downstream client error.'),
        result.status,
      );
    }
    case 'server_error':
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-booking returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'timeout':
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-booking did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'network_error':
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-booking is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'not_configured':
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure BOOKING_SERVICE_BASE_URL.`,
        ...(traceId !== undefined && { traceId }),
      });
  }
}

function toBodyOrFallback(body: unknown, fallbackDetail: string): Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {
    type: 'about:blank',
    title: 'Bad Request',
    status: HttpStatus.BAD_REQUEST,
    detail: fallbackDetail,
  };
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

function extractTraceId(request: Request): string | undefined {
  const header = request.headers['x-trace-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readIdempotencyKey(request: Request): string | undefined {
  const header = request.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}
