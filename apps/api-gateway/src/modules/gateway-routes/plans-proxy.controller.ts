import {
  BadGatewayException,
  Controller,
  Get,
  GatewayTimeoutException,
  HttpCode,
  HttpException,
  HttpStatus,
  Req,
  ServiceUnavailableException,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { PlansListResponseSchema, type PlansListResponse } from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * `GET /api/v1/plans` (TS-140 proxy).
 *
 * Forwards the authenticated request to service-subscription's plans
 * catalog endpoint and renders the response. Demonstrates the full
 * gateway flow end-to-end:
 *
 *   1. AccessTokenGuard verifies the JWT + attaches `requestContext`.
 *   2. RateLimitGuard consumes one slot from the default policy.
 *   3. DownstreamHttpClient mints + attaches the trust-header envelope,
 *      issues the fetch with an AbortController timeout, classifies
 *      the response into a `DownstreamResult`.
 *   4. The handler maps the result onto the HTTP response, validating
 *      the body against the `PlansListResponseSchema` contract before
 *      returning it to the client.
 *
 * Failure-mapping discipline (mirror of CLAUDE.md §5.1 RFC 7807):
 *
 *   - `not_configured`    → 503 Service Unavailable
 *   - `timeout`           → 504 Gateway Timeout
 *   - `network_error`     → 502 Bad Gateway
 *   - `server_error` (5xx) → 502 Bad Gateway
 *   - `client_error` (4xx) → re-throw with the downstream's status + body
 *   - `ok` with malformed body → 502 Bad Gateway with a
 *     "contract violation" detail line (a sign of a service drift
 *     between gateway + subscription).
 */
@Controller('api/v1/plans')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class PlansProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Req() request: RequestWithContext): Promise<PlansListResponse> {
    const ctx = request.requestContext;
    if (ctx === undefined) {
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: HttpStatus.UNAUTHORIZED,
        detail: 'Authentication required.',
      });
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'subscription',
      path: '/api/v1/plans',
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    switch (result.kind) {
      case 'ok': {
        const parsed = PlansListResponseSchema.safeParse(result.body);
        if (!parsed.success) {
          throw new BadGatewayException({
            type: 'about:blank',
            title: 'Bad Gateway',
            status: HttpStatus.BAD_GATEWAY,
            detail:
              'Downstream service-subscription returned a body that does not conform to the PlansListResponse contract.',
          });
        }
        return parsed.data;
      }
      case 'client_error': {
        // Forward the downstream's status verbatim so callers can react
        // to 404 / 403 / etc. correctly. The body may already be a RFC
        // 7807 problem-details document from the downstream — we surface
        // it unmodified.
        const body = toBodyOrFallback(result.body, 'Downstream client error.');
        throw new HttpException(body, result.status);
      }
      case 'server_error': {
        throw new BadGatewayException({
          type: 'about:blank',
          title: 'Bad Gateway',
          status: HttpStatus.BAD_GATEWAY,
          detail: 'Downstream service-subscription returned an unsuccessful response.',
        });
      }
      case 'timeout': {
        throw new GatewayTimeoutException({
          type: 'about:blank',
          title: 'Gateway Timeout',
          status: HttpStatus.GATEWAY_TIMEOUT,
          detail: 'Downstream service-subscription did not respond within the timeout window.',
        });
      }
      case 'network_error': {
        throw new BadGatewayException({
          type: 'about:blank',
          title: 'Bad Gateway',
          status: HttpStatus.BAD_GATEWAY,
          detail: 'Downstream service-subscription is unreachable.',
        });
      }
      case 'not_configured': {
        throw new ServiceUnavailableException({
          type: 'about:blank',
          title: 'Service Unavailable',
          status: HttpStatus.SERVICE_UNAVAILABLE,
          detail: `Gateway has no route for the '${result.service}' service. Configure SUBSCRIPTION_SERVICE_BASE_URL.`,
        });
      }
    }
  }
}

function toBodyOrFallback(body: unknown, fallbackDetail: string): string | Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {
    type: 'about:blank',
    title: 'Error',
    detail: fallbackDetail,
  };
}

function extractTraceId(request: RequestWithContext): string | undefined {
  const candidates = [request.headers['x-trace-id'], request.headers['x-request-id']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}
