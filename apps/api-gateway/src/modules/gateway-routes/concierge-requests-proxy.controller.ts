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
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ConciergeTicketsListResponseSchema,
  ListMyConciergeRequestsQuerySchema,
  SubmitConciergeRequestRequestSchema,
  SubmitConciergeRequestResponseSchema,
  type ConciergeTicketsListResponse,
  type ListMyConciergeRequestsQuery,
  type SubmitConciergeRequestResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Family concierge-requests BFF proxy (TS-223; PRD §6.6 "Concierge Service
 * Requests"; PDD §10.6).
 *
 *   `POST /api/v1/concierge/requests`
 *     Submit a concierge service request. Authenticated under the default
 *     rate-limit policy. The body is re-validated against the contract
 *     schema at the gateway (defence-in-depth) before forwarding; the
 *     inbound `Idempotency-Key` is forwarded so service-concierge's
 *     `@Idempotent()` interceptor collapses a client-side retry. 201 + the
 *     created ticket.
 *
 *   `GET /api/v1/concierge/requests/me`
 *     The actor household's submitted requests, newest-first. The list
 *     query is allow-listed (only `limit`) so a smuggled param can't ride
 *     through to service-concierge.
 *
 * service-concierge resolves the household from the token's `tenantScope`
 * claim (no household id crosses the wire), so the gateway is a thin
 * pass-through forwarding the verified actor identity. A non-household
 * actor (admin / partner) receives the downstream 400 verbatim — these
 * surfaces are for household members only.
 */
@Controller('api/v1/concierge/requests')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class ConciergeRequestsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<SubmitConciergeRequestResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = SubmitConciergeRequestRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Concierge request payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: '/api/v1/concierge/requests',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      SubmitConciergeRequestResponseSchema,
      'concierge-request-submit',
      traceId,
    );
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  async listMine(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<ConciergeTicketsListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ListMyConciergeRequestsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Concierge requests list query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: buildListPath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      ConciergeTicketsListResponseSchema,
      'concierge-requests-list',
      traceId,
    );
  }
}

/**
 * Rebuild the downstream query string from the validated query — a
 * defence-in-depth allow-list so a smuggled param can't ride through.
 */
function buildListPath(query: ListMyConciergeRequestsQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  return `/api/v1/concierge/requests/me?${params.toString()}`;
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
          detail: `Downstream service-concierge returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-concierge returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-concierge did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-concierge is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure CONCIERGE_SERVICE_BASE_URL.`,
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
