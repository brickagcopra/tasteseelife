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
  ListProvidersQuerySchema,
  ProviderDirectoryListResponseSchema,
  type ProviderDirectoryListResponse,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Admin provider directory BFF proxy (TS-305c-followup-1; PRD §10.14,
 * PDD §16.1).
 *
 *   `GET /api/v1/admin/providers?q=&status=&tier=&includeArchived=&limit=&offset=`
 *     The list an operator uses to FIND a provider. Gated
 *     `provider:read` — the same gate as service-provider's route and
 *     as the dossier, and deliberately NOT `provider:approve`, which
 *     is a write authority.
 *
 * **A pure proxy, not an aggregator.** It shares the
 * `api/v1/admin/providers` prefix with `AdminProvider360Aggregator-
 * Controller` and nothing else: that route fans out to two services
 * and degrades one of them, this one forwards a single call. Keeping
 * them apart means the composition logic and its degradation rules
 * stay in the file that has them; the two routes cannot collide
 * (`''` versus `':providerId/360'`).
 *
 * **The query is parsed HERE and the downstream URL is re-serialised
 * from the PARSED value.** `.strict()` makes an unknown filter key a
 * 400 at the edge, and nothing unvalidated reaches the downstream
 * query string. This matters more than usual for a directory: a
 * silently-dropped filter returns a longer list, and a longer list
 * looks like a successful search rather than a failed one.
 *
 * service-provider re-validates the same schema itself — the edge gate
 * is never the only gate.
 *
 * **No idempotency key** — GET is naturally idempotent.
 */
@Controller('api/v1/admin/providers')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminProvidersProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('provider:read')
  async listProviders(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<ProviderDirectoryListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ListProvidersQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Provider directory query failed validation.', parsed.error.issues);
    }

    const search = new URLSearchParams();
    for (const key of ['q', 'status', 'tier'] as const) {
      const value = parsed.data[key];
      if (value !== undefined) search.set(key, value);
    }
    // Always sent, never inferred downstream: `includeArchived` decides
    // whether an archived provider is visible at all, and a filter that
    // load-bearing should not depend on two services agreeing on a
    // default.
    search.set('includeArchived', String(parsed.data.includeArchived));
    search.set('limit', String(parsed.data.limit));
    search.set('offset', String(parsed.data.offset));

    const result: DownstreamResult = await this.downstream.call({
      service: 'provider',
      path: `/api/v1/admin/providers?${search.toString()}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, ProviderDirectoryListResponseSchema, 'provider-directory', traceId);
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
          detail: `Downstream service-provider returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-provider returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-provider did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-provider is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure PROVIDER_SERVICE_BASE_URL.`,
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
