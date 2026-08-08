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
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  MySubscriptionResponseSchema,
  type MySubscriptionResponse,
} from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * The family's own membership, BFF proxy
 * (TS-042-followup-3a3-followup-1a).
 *
 *   `GET /api/v1/subscriptions/me`
 *
 * Authenticated + rate-limited under the default policy. No query, no
 * path parameter, nothing to validate on the way in — the household
 * comes from the signed actor context `HouseholdScopeInterceptor`
 * established, so this route has no id to be pointed at somebody else's
 * membership.
 *
 * **Response re-validation is a disclosure control here.** The family
 * DTO is deliberately narrower than the operator's `SubscriptionResponse`
 * — no Stripe ids, no retry count, no pause reason — and `.strict()` is
 * what keeps a widened downstream projection from reaching a browser.
 * Drift is a 502.
 *
 * Declared before any `/api/v1/subscriptions/:id` proxy would be, so the
 * literal `me` cannot be captured as a parameter.
 */
@Controller('api/v1/subscriptions/me')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class MySubscriptionProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async read(@Req() request: RequestWithContext): Promise<MySubscriptionResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'subscription',
      path: '/api/v1/subscriptions/me',
      method: 'GET',
      actor: ctx,
      traceId,
    });

    switch (result.kind) {
      case 'ok': {
        const validated = MySubscriptionResponseSchema.safeParse(result.body);
        if (!validated.success) {
          throw new BadGatewayException({
            type: 'about:blank',
            title: 'Bad Gateway',
            status: HttpStatus.BAD_GATEWAY,
            detail:
              'Downstream service-subscription returned a body that does not conform to the MySubscriptionResponse contract.',
            ...(traceId !== undefined && { traceId }),
          });
        }
        return validated.data;
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
