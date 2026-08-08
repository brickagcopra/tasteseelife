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
  SearchProvidersRequestSchema,
  SearchProvidersResponseSchema,
  type SearchProvidersResponse,
} from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Provider-discovery search BFF proxy (TS-125).
 *
 *   `POST /api/v1/search/providers`
 *     Forwards the validated request to `service-search` and returns
 *     the search hits + facets + cursor. Drives the family-portal
 *     `/providers` browse page.
 *
 * Authenticated + default-rate-limited. Mirrors the failure-mapping
 * discipline of PlansProxyController / CheckoutSessionsProxyController:
 *
 *   - `not_configured`   → 503 with config hint
 *   - `timeout`          → 504
 *   - `network_error`    → 502
 *   - `server_error`     → 502
 *   - `client_error`     → re-throw verbatim
 *   - `ok` + malformed   → 502 (contract violation)
 */
@Controller('api/v1/search/providers')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class SearchProvidersProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async search(
    @Body() body: unknown,
    @Req() request: RequestWithContext,
  ): Promise<SearchProvidersResponse> {
    const ctx = requireContext(request);
    const parsed = SearchProvidersRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Search request payload failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: '/api/v1/search/providers',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      // idempotency: a read wearing POST. The verb is here because a provider
      // search carries a filter object too large and too nested for a query
      // string, not because anything is written. Nothing to collapse.
      idempotencyKey: undefined,
      traceId: extractTraceId(request),
    });

    return mapResult(
      result,
      SearchProvidersResponseSchema,
      'search-providers',
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
          detail: `Downstream service-search returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-search returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-search did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-search is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure SEARCH_SERVICE_BASE_URL.`,
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
