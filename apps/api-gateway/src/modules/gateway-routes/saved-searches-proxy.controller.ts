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
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  CreateSavedSearchRequestSchema,
  DeleteSavedSearchResponseSchema,
  GetSavedSearchResponseSchema,
  RunSavedSearchResponseSchema,
  SavedSearchSchema,
  SavedSearchesListResponseSchema,
  UpdateSavedSearchRequestSchema,
  type DeleteSavedSearchResponse,
  type GetSavedSearchResponse,
  type RunSavedSearchResponse,
  type SavedSearch,
  type SavedSearchesListResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Saved-searches BFF proxy (TS-215; GET :id from TS-215-followup-1). Six surfaces:
 *
 *   GET    /api/v1/saved-searches              — list mine
 *   GET    /api/v1/saved-searches/:id          — fetch one (TS-215-followup-1)
 *   POST   /api/v1/saved-searches              — create one
 *   PATCH  /api/v1/saved-searches/:id          — rename / change query
 *   POST   /api/v1/saved-searches/:id/run      — bump lastRunAt
 *   DELETE /api/v1/saved-searches/:id          — delete (idempotent)
 *
 * Authenticated + default-rate-limited. Forwards to service-search.
 * The downstream service is the source of truth for row-level
 * ownership — the gateway just propagates the authenticated actor's
 * context.
 *
 * Failure mapping mirrors the other proxies in this module:
 *
 *   `not_configured`   → 503 with config hint (SEARCH_SERVICE_BASE_URL)
 *   `timeout`          → 504
 *   `network_error`    → 502
 *   `server_error`     → 502
 *   `client_error`     → re-throw verbatim (401/404/409/422 from svc)
 *   `ok` + malformed   → 502 (contract violation)
 */
@Controller('api/v1/saved-searches')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class SavedSearchesProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Req() request: RequestWithContext): Promise<SavedSearchesListResponse> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: '/api/v1/saved-searches',
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });
    return mapResult(
      result,
      SavedSearchesListResponseSchema,
      'saved-searches-list',
      extractTraceId(request),
    );
  }

  /**
   * Single-row read (TS-215-followup-1). The /providers page hydrates
   * its filter form from the returned `query` body when the family
   * lands on `/providers?savedSearchId=…` after clicking "Run" on a
   * saved search. Row-level ownership is enforced downstream; the
   * gateway just forwards the authenticated actor's context.
   */
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async get(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
  ): Promise<GetSavedSearchResponse> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: `/api/v1/saved-searches/${encodeURIComponent(id)}`,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });
    return mapResult(
      result,
      GetSavedSearchResponseSchema,
      'saved-searches-get',
      extractTraceId(request),
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SavedSearch> {
    const ctx = requireContext(request);
    const parsed = CreateSavedSearchRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Saved-search create payload failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: '/api/v1/saved-searches',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });

    return mapResult(result, SavedSearchSchema, 'saved-searches-create', extractTraceId(request));
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SavedSearch> {
    const ctx = requireContext(request);
    const parsed = UpdateSavedSearchRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Saved-search update payload failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: `/api/v1/saved-searches/${encodeURIComponent(id)}`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });

    return mapResult(result, SavedSearchSchema, 'saved-searches-update', extractTraceId(request));
  }

  @Post(':id/run')
  @HttpCode(HttpStatus.OK)
  async run(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RunSavedSearchResponse> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: `/api/v1/saved-searches/${encodeURIComponent(id)}/run`,
      method: 'POST',
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });
    return mapResult(
      result,
      RunSavedSearchResponseSchema,
      'saved-searches-run',
      extractTraceId(request),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<DeleteSavedSearchResponse> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'search',
      path: `/api/v1/saved-searches/${encodeURIComponent(id)}`,
      method: 'DELETE',
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });
    return mapResult(
      result,
      DeleteSavedSearchResponseSchema,
      'saved-searches-delete',
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
