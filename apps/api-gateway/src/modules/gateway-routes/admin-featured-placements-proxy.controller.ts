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
  Inject,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  DeleteFeaturedPlacementResponseSchema,
  FeaturedPlacementsListResponseSchema,
  ListFeaturedPlacementsQuerySchema,
  ScheduleFeaturedPlacementRequestSchema,
  ScheduleFeaturedPlacementResponseSchema,
  type DeleteFeaturedPlacementResponse,
  type FeaturedPlacementsListResponse,
  type ListFeaturedPlacementsQuery,
  type ScheduleFeaturedPlacementResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { SuperAdminRoleGuard } from '../../common/guards/admin-role.guard';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Admin featured-placements BFF proxy (TS-207).
 *
 *   `GET    /api/v1/admin/search/featured-placements`              — list
 *   `POST   /api/v1/admin/search/featured-placements`             — schedule
 *   `DELETE /api/v1/admin/search/featured-placements/:placementId` — cancel
 *
 * Forwards to service-search's shared-secret-pinned internal endpoint
 * (`/api/v1/internal/search/featured-placements`) so the shared secret never
 * reaches the browser. Twin of `AdminSearchRankingConfigProxyController` —
 * same three guards (AccessToken → SuperAdminRole → RateLimit), same
 * shared-secret forwarding via `extraHeaders`, same `mapResult` failure
 * table.
 *
 * **Actor attribution on schedule.** The gateway stamps the authenticated
 * actor's `userId` into the POST body's `createdByUserId` field so ops audit
 * can see who scheduled the placement. This overrides any value the caller
 * smuggled in the body (the field is optional + intended for gateway-side
 * attribution).
 *
 * **Idempotency-Key.** The POST proxy forwards the inbound `Idempotency-Key`
 * header so a client-side retry can collapse against any future
 * `@Idempotent()`-decorated schedule endpoint (forward-compat — today the
 * internal endpoint creates unconditionally).
 */
@Controller('api/v1/admin/search/featured-placements')
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard, RateLimitGuard)
export class AdminFeaturedPlacementsProxyController {
  constructor(
    private readonly downstream: DownstreamHttpClient,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<FeaturedPlacementsListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);
    const extraHeaders = this.requireSharedSecret(traceId);

    const parsed = ListFeaturedPlacementsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Featured-placements list query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: buildListPath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
      extraHeaders,
    });

    return mapResult(
      result,
      FeaturedPlacementsListResponseSchema,
      'admin-featured-placements-list',
      traceId,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async schedule(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<ScheduleFeaturedPlacementResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);
    const extraHeaders = this.requireSharedSecret(traceId);

    const parsed = ScheduleFeaturedPlacementRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'Featured-placement schedule payload failed validation.',
        parsed.error.issues,
      );
    }

    // Stamp the authenticated actor's userId so ops audit captures who
    // scheduled the placement. Overrides any smuggled value.
    const forwardBody = { ...parsed.data, createdByUserId: ctx.userId };

    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: '/api/v1/internal/search/featured-placements',
      method: 'POST',
      body: forwardBody,
      actor: ctx,
      traceId,
      extraHeaders,
      idempotencyKey,
    });

    return mapResult(
      result,
      ScheduleFeaturedPlacementResponseSchema,
      'admin-featured-placements-schedule',
      traceId,
    );
  }

  @Delete(':placementId')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('placementId') placementId: string,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<DeleteFeaturedPlacementResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);
    const extraHeaders = this.requireSharedSecret(traceId);

    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: `/api/v1/internal/search/featured-placements/${encodeURIComponent(placementId)}`,
      method: 'DELETE',
      actor: ctx,
      traceId,
      idempotencyKey,
      extraHeaders,
    });

    return mapResult(
      result,
      DeleteFeaturedPlacementResponseSchema,
      'admin-featured-placements-delete',
      traceId,
    );
  }

  /**
   * Return the `extraHeaders` bag carrying the shared secret, or throw 503
   * if it's unset — better a 503 with a specific detail than a silent 401
   * from the downstream when the secret is missing.
   */
  private requireSharedSecret(traceId: string | undefined): Readonly<Record<string, string>> {
    if (this.env.SEARCH_INDEX_API_KEY === undefined) {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail:
          'Gateway has no shared secret for the search featured-placements endpoint. Configure SEARCH_INDEX_API_KEY.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    return { [this.env.SEARCH_INDEX_HEADER_NAME]: this.env.SEARCH_INDEX_API_KEY };
  }
}

/**
 * Rebuild the downstream query string from the validated query — a
 * defence-in-depth allow-list so a smuggled param can't ride through to
 * service-search.
 */
function buildListPath(query: ListFeaturedPlacementsQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  if (query.providerId !== undefined) params.set('providerId', query.providerId);
  if (query.activeOnly !== undefined) params.set('activeOnly', String(query.activeOnly));
  return `/api/v1/internal/search/featured-placements?${params.toString()}`;
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
