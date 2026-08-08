import {
  BadGatewayException,
  Body,
  Controller,
  Get,
  GatewayTimeoutException,
  Headers,
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
  CreateCheckoutSessionRequestSchema,
  CreateCheckoutSessionResponseSchema,
  FinalizeCheckoutSessionRequestSchema,
  GetCheckoutSessionResponseSchema,
  SubscriptionResponseSchema,
  type CreateCheckoutSessionRequest,
  type CreateCheckoutSessionResponse,
  type FinalizeCheckoutSessionRequest,
  type GetCheckoutSessionResponse,
  type SubscriptionResponse,
} from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Stripe Checkout sessions BFF proxy (TS-124).
 *
 * Three surfaces, all authenticated + rate-limited under the default
 * policy. The proxy forwards the request to service-subscription's
 * checkout endpoints with the actor's RequestContext on the trust
 * envelope, then maps the typed `DownstreamResult` onto the HTTP
 * response.
 *
 *   - `POST /api/v1/subscriptions/checkout-sessions`
 *     Forward the body; return the hosted Stripe URL.
 *
 *   - `GET  /api/v1/subscriptions/checkout-sessions/:id`
 *     Forward the session id; return the session status.
 *
 *   - `POST /api/v1/subscriptions/checkout-sessions/:id/finalize`
 *     Forward the session id (empty body); return the local
 *     SubscriptionResponse.
 *
 * Failure mapping mirrors PlansProxyController:
 *   - `not_configured`   → 503 (with config hint)
 *   - `timeout`          → 504
 *   - `network_error`    → 502
 *   - `server_error`     → 502
 *   - `client_error`     → re-throw with the downstream's status + body
 *   - `ok` + malformed   → 502 (contract violation surfaces immediately)
 *
 * **`Idempotency-Key` is forwarded on both writes** (TS-505d-prep-followup-1).
 * Both downstream routes wear `@Idempotent()`, and this is the money path:
 * a double-submitted create is a second Stripe checkout session, a retried
 * finalize is a second subscription activation.
 *
 * This proxy previously read the header into a discarded `_idempotencyKey`
 * parameter, on the reasoning that a retry would collapse on the gateway's
 * own idempotency cache before reaching service-subscription. **That cache
 * does not exist** — TS-140-followup-5 was never done and
 * `@taste-and-see/nest-idempotency` is not a gateway dependency — so the
 * only replay protection on the path was the downstream decorator, which
 * had nothing to key on because the value died here.
 */
@Controller('api/v1/subscriptions/checkout-sessions')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class CheckoutSessionsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: CreateCheckoutSessionRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CreateCheckoutSessionResponse> {
    const ctx = requireContext(request);
    const parsed = CreateCheckoutSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Checkout session payload failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'subscription',
      path: '/api/v1/subscriptions/checkout-sessions',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });

    return mapResult(
      result,
      CreateCheckoutSessionResponseSchema,
      'create-checkout-session',
      extractTraceId(request),
    );
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async get(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
  ): Promise<GetCheckoutSessionResponse> {
    const ctx = requireContext(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'subscription',
      path: `/api/v1/subscriptions/checkout-sessions/${encodeURIComponent(id)}`,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    return mapResult(
      result,
      GetCheckoutSessionResponseSchema,
      'get-checkout-session',
      extractTraceId(request),
    );
  }

  @Post(':id/finalize')
  @HttpCode(HttpStatus.OK)
  async finalize(
    @Param('id') id: string,
    @Body() body: FinalizeCheckoutSessionRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SubscriptionResponse> {
    const ctx = requireContext(request);
    const parsed = FinalizeCheckoutSessionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Finalize payload failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'subscription',
      path: `/api/v1/subscriptions/checkout-sessions/${encodeURIComponent(id)}/finalize`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });

    return mapResult(
      result,
      SubscriptionResponseSchema,
      'finalize-checkout-session',
      extractTraceId(request),
    );
  }
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
