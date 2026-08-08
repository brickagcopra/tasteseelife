import {
  BadGatewayException,
  Body,
  Controller,
  Delete,
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
  CreateFavoriteProviderRequestSchema,
  CreateFavoriteProviderResponseSchema,
  DeleteFavoriteProviderResponseSchema,
  FavoriteProvidersListResponseSchema,
  type CreateFavoriteProviderResponse,
  type DeleteFavoriteProviderResponse,
  type FavoriteProvidersListResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Favourite-providers BFF proxy (TS-215). Three surfaces:
 *
 *   GET    /api/v1/favorite-providers?providerId=&seniorId=  — list mine
 *   POST   /api/v1/favorite-providers                        — upsert
 *   DELETE /api/v1/favorite-providers/:id                    — delete
 *
 * Authenticated + default-rate-limited. Forwards to service-search.
 * Failure mapping is the canonical shape used by every other proxy in
 * this module.
 */
@Controller('api/v1/favorite-providers')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class FavoriteProvidersProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query('providerId') providerId: string | undefined,
    @Query('seniorId') seniorId: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<FavoriteProvidersListResponse> {
    const ctx = requireContext(request);
    const params = new URLSearchParams();
    if (typeof providerId === 'string' && providerId.length > 0) {
      params.set('providerId', providerId);
    }
    // `seniorId=null` (or empty string) is meaningful — preserve it. The
    // downstream interprets both as "no-senior favourites only".
    if (typeof seniorId === 'string') {
      params.set('seniorId', seniorId);
    }
    const qs = params.toString();
    const path = qs.length > 0 ? `/api/v1/favorite-providers?${qs}` : '/api/v1/favorite-providers';

    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });
    return mapResult(
      result,
      FavoriteProvidersListResponseSchema,
      'favorite-providers-list',
      extractTraceId(request),
    );
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async upsert(
    @Body() body: unknown,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CreateFavoriteProviderResponse> {
    const ctx = requireContext(request);
    const parsed = CreateFavoriteProviderRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Favourite-provider upsert payload failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: '/api/v1/favorite-providers',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });
    return mapResult(
      result,
      CreateFavoriteProviderResponseSchema,
      'favorite-providers-upsert',
      extractTraceId(request),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<DeleteFavoriteProviderResponse> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: `/api/v1/favorite-providers/${encodeURIComponent(id)}`,
      method: 'DELETE',
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });
    return mapResult(
      result,
      DeleteFavoriteProviderResponseSchema,
      'favorite-providers-delete',
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
