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
  InvoicesListResponseSchema,
  ListInvoicesQuerySchema,
  type InvoicesListResponse,
  type ListInvoicesQuery,
} from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Invoices BFF proxy (TS-124).
 *
 *   `GET /api/v1/invoices?subscriptionId=...&limit=...&startingAfter=...`
 *
 * Authenticated + rate-limited under the default policy. Validates the
 * query parameters against the contract schema (rejects unknown fields,
 * normalises types), then forwards to service-subscription's read-through
 * Stripe invoices surface.
 */
@Controller('api/v1/invoices')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class InvoicesProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query() rawQuery: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<InvoicesListResponse> {
    const ctx = requireContext(request);
    const parsed = ListInvoicesQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Invoices list query failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const traceId = extractTraceId(request);
    const queryString = buildQueryString(parsed.data);

    const result: DownstreamResult = await this.downstream.call({
      service: 'subscription',
      path: `/api/v1/invoices${queryString}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    switch (result.kind) {
      case 'ok': {
        const validated = InvoicesListResponseSchema.safeParse(result.body);
        if (!validated.success) {
          throw new BadGatewayException({
            type: 'about:blank',
            title: 'Bad Gateway',
            status: HttpStatus.BAD_GATEWAY,
            detail:
              'Downstream service-subscription returned a body that does not conform to the InvoicesListResponse contract.',
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

/**
 * Build the query string the gateway forwards to service-subscription.
 * Mirrors the typed `ListInvoicesQuery` shape exactly — no stray params
 * survive validation, and every value is URL-encoded.
 */
function buildQueryString(query: ListInvoicesQuery): string {
  const params = new URLSearchParams();
  params.set('subscriptionId', query.subscriptionId);
  params.set('limit', String(query.limit));
  if (query.startingAfter !== undefined) {
    params.set('startingAfter', query.startingAfter);
  }
  return `?${params.toString()}`;
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
