import {
  BadGatewayException,
  Body,
  Controller,
  GatewayTimeoutException,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  BillingPortalSessionResponseSchema,
  CreateBillingPortalSessionRequestSchema,
  type BillingPortalSessionResponse,
} from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Stripe Billing Portal BFF proxy
 * (TS-042-followup-3a3-followup-1).
 *
 *   `POST /api/v1/billing/portal-sessions`
 *
 * Authenticated + rate-limited under the default policy. Forwards to
 * service-subscription, which mints the session.
 *
 * **The gateway supplies no ids and rewrites nothing.** It does not need
 * to: `HouseholdScopeInterceptor` (TS-505d2-followup-5) has already
 * narrowed `requestContext.tenantScope` to the caller's household by the
 * time this handler runs, and `DownstreamHttpClient` signs that context
 * into the `x-ts-trust-*` envelope the service reads. The household
 * therefore travels as *authenticated context*, not as a parameter
 * anybody could have written — which is the whole security argument for
 * this endpoint's shape.
 *
 * **The body is validated here as well as downstream**, because the
 * empty-and-strict body is the control that stops a caller naming
 * someone else's Stripe customer or a `return_url` of their choosing.
 * Rejecting at the edge means such a request never reaches the service
 * at all.
 *
 * **The response is re-validated** and drift is a 502. That is not
 * ceremony here: the contract is one field, and anything extra
 * service-subscription might start returning about a billing customer
 * would be leaking through the gateway to a browser.
 */
@Controller('api/v1/billing/portal-sessions')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class BillingPortalProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() rawBody: unknown,
    @Req() request: RequestWithContext,
  ): Promise<BillingPortalSessionResponse> {
    const ctx = requireContext(request);

    // An absent body is the normal case for a fetch with no payload;
    // treat it as `{}` so a client is not forced to send one.
    const parsed = CreateBillingPortalSessionRequestSchema.safeParse(rawBody ?? {});
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail:
            'Billing portal session requests take no fields. The billing customer is ' +
            'determined by who you are signed in as.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const traceId = extractTraceId(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'subscription',
      path: '/api/v1/billing/portal-sessions',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      // idempotency: forwarded verbatim — the downstream route wears
      // `@Idempotent()` and a portal URL is single-use, so a retried
      // double-submit must replay rather than mint a second link.
      idempotencyKey: readIdempotencyKey(request),
    });

    switch (result.kind) {
      case 'ok': {
        const validated = BillingPortalSessionResponseSchema.safeParse(result.body);
        if (!validated.success) {
          throw new BadGatewayException({
            type: 'about:blank',
            title: 'Bad Gateway',
            status: HttpStatus.BAD_GATEWAY,
            detail:
              'Downstream service-subscription returned a body that does not conform to the BillingPortalSessionResponse contract.',
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

/**
 * Pass the caller's `Idempotency-Key` through. A portal URL is
 * single-use, so a double-submit that minted two sessions could hand the
 * family a link that is already spent — the replay cache downstream is
 * what makes the retry safe.
 */
function readIdempotencyKey(request: RequestWithContext): string | undefined {
  const raw = request.headers['idempotency-key'];
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return undefined;
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
