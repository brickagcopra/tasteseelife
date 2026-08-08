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
  Put,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  DeleteSearchRankingConfigResponseSchema,
  GetSearchRankingConfigResponseSchema,
  ListSearchRankingConfigResponseSchema,
  SearchRankingConfigRegionCodeSchema,
  UpsertSearchRankingConfigRequestSchema,
  UpsertSearchRankingConfigResponseSchema,
  type DeleteSearchRankingConfigResponse,
  type GetSearchRankingConfigResponse,
  type ListSearchRankingConfigResponse,
  type UpsertSearchRankingConfigResponse,
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
 * Admin search ranking-config BFF proxy (TS-211-followup-1).
 *
 *   `GET    /api/v1/admin/search/ranking-config`               — list
 *   `GET    /api/v1/admin/search/ranking-config/:regionCode`   — get one
 *   `PUT    /api/v1/admin/search/ranking-config/:regionCode`   — upsert
 *   `DELETE /api/v1/admin/search/ranking-config/:regionCode`   — delete
 *
 * Forwards the four routes to service-search's shared-secret-pinned
 * internal endpoint (`/api/v1/internal/search/ranking-config{/:regionCode}`)
 * so the shared secret never reaches the browser. The gateway-side
 * surface is the load-bearing UX path; ops can still curl the internal
 * endpoint directly when the BFF is unavailable.
 *
 * All four routes sit behind three guards (in order):
 *   1. `AccessTokenGuard`    — verify the JWT + attach RequestContext.
 *   2. `SuperAdminRoleGuard` — require an active super_admin role.
 *   3. `RateLimitGuard`      — apply the default policy.
 *
 * **Shared-secret forwarding.** Every downstream hop carries the
 * `SEARCH_INDEX_HEADER_NAME` header with `SEARCH_INDEX_API_KEY` as
 * value via `DownstreamHttpClient`'s `extraHeaders` knob. The gateway's
 * own headers (trust headers + trace id) always win on collision
 * because `extraHeaders` are merged FIRST and the gateway headers
 * overwrite them — that ordering is established by the downstream
 * client's lowercase-merge loop.
 *
 * **Actor attribution on upsert.** The gateway stamps the authenticated
 * actor's `userId` into the PUT body's `updatedByUserId` field so ops
 * audit can see who last tweaked the weights. This overrides any
 * value the caller smuggled in the body (which is fine — the field is
 * optional and intended for gateway-side attribution).
 *
 * **Idempotency-Key.** The PUT proxy forwards the inbound
 * `Idempotency-Key` header to the downstream so a client-side retry
 * can collapse against any future `@Idempotent()`-decorated upsert.
 * Today service-search's upsert is naturally idempotent (a byte-equal
 * replay returns `unchanged`) so the forward is for forward-compat.
 *
 * **`not_configured` → 503.** When `SEARCH_INDEX_API_KEY` is unset on
 * the gateway env, the proxy short-circuits with a 503 carrying a
 * specific detail line so ops can fix the env gap quickly. The
 * service-search base URL gap surfaces the same way via the downstream
 * client's `not_configured` result variant.
 */
@Controller('api/v1/admin/search/ranking-config')
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard, RateLimitGuard)
export class AdminSearchRankingConfigProxyController {
  constructor(
    private readonly downstream: DownstreamHttpClient,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Req() request: RequestWithContext): Promise<ListSearchRankingConfigResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);
    const extraHeaders = this.requireSharedSecret(traceId);

    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: '/api/v1/internal/search/ranking-config',
      method: 'GET',
      actor: ctx,
      traceId,
      extraHeaders,
    });

    return mapResult(
      result,
      ListSearchRankingConfigResponseSchema,
      'admin-search-ranking-config-list',
      traceId,
    );
  }

  @Get(':regionCode')
  @HttpCode(HttpStatus.OK)
  async getByRegion(
    @Param('regionCode') regionCode: string,
    @Req() request: RequestWithContext,
  ): Promise<GetSearchRankingConfigResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);
    const extraHeaders = this.requireSharedSecret(traceId);
    validateRegionCode(regionCode);

    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: `/api/v1/internal/search/ranking-config/${encodeURIComponent(regionCode)}`,
      method: 'GET',
      actor: ctx,
      traceId,
      extraHeaders,
    });

    return mapResult(
      result,
      GetSearchRankingConfigResponseSchema,
      'admin-search-ranking-config-get',
      traceId,
    );
  }

  @Put(':regionCode')
  @HttpCode(HttpStatus.OK)
  async upsertByRegion(
    @Param('regionCode') regionCode: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<UpsertSearchRankingConfigResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);
    const extraHeaders = this.requireSharedSecret(traceId);
    validateRegionCode(regionCode);

    const parsed = UpsertSearchRankingConfigRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'Search ranking-config upsert payload failed validation.',
        parsed.error.issues,
      );
    }

    // Stamp the authenticated actor's userId into the forwarded body so
    // ops audit captures who last tweaked the weights. Overrides any
    // smuggled value — the field is intended for gateway-side
    // attribution.
    const forwardBody = { ...parsed.data, updatedByUserId: ctx.userId };

    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: `/api/v1/internal/search/ranking-config/${encodeURIComponent(regionCode)}`,
      method: 'PUT',
      body: forwardBody,
      actor: ctx,
      traceId,
      extraHeaders,
      idempotencyKey,
    });

    return mapResult(
      result,
      UpsertSearchRankingConfigResponseSchema,
      'admin-search-ranking-config-upsert',
      traceId,
    );
  }

  @Delete(':regionCode')
  @HttpCode(HttpStatus.OK)
  async deleteByRegion(
    @Param('regionCode') regionCode: string,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<DeleteSearchRankingConfigResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);
    const extraHeaders = this.requireSharedSecret(traceId);
    validateRegionCode(regionCode);

    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: `/api/v1/internal/search/ranking-config/${encodeURIComponent(regionCode)}`,
      method: 'DELETE',
      actor: ctx,
      traceId,
      idempotencyKey,
      extraHeaders,
    });

    return mapResult(
      result,
      DeleteSearchRankingConfigResponseSchema,
      'admin-search-ranking-config-delete',
      traceId,
    );
  }

  /**
   * Return the `extraHeaders` bag carrying the shared secret, or throw
   * 503 if it's unset. Better a 503 with a specific detail than a
   * silent 401 from the downstream when the secret is missing.
   */
  private requireSharedSecret(traceId: string | undefined): Readonly<Record<string, string>> {
    if (this.env.SEARCH_INDEX_API_KEY === undefined) {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail:
          'Gateway has no shared secret for the search ranking-config endpoint. Configure SEARCH_INDEX_API_KEY.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    return { [this.env.SEARCH_INDEX_HEADER_NAME]: this.env.SEARCH_INDEX_API_KEY };
  }
}

/**
 * Pre-flight region-code validation. The downstream's
 * `ZodValidationPipe(SearchRankingConfigRegionCodeSchema)` will also
 * reject a malformed slug; doing it at the gateway shaves an
 * unnecessary downstream hop on the common-case typo and gives the
 * caller an RFC 7807 error keyed to the gateway path.
 */
function validateRegionCode(regionCode: string): void {
  const parsed = SearchRankingConfigRegionCodeSchema.safeParse(regionCode);
  if (!parsed.success) {
    throw badRequest('regionCode failed validation.', parsed.error.issues);
  }
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
      // Forward the downstream's status verbatim (404 / 422 / etc.)
      // alongside the problem-details body it returned.
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
