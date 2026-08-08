import {
  BadGatewayException,
  Body,
  Controller,
  GatewayTimeoutException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  AdPlacementsListResponseSchema,
  AdSlotScheduleResponseSchema,
  AdSlotSchedulesListResponseSchema,
  CreateAdSlotScheduleRequestSchema,
  ListAdSlotSchedulesQuerySchema,
  UpdateAdSlotScheduleRequestSchema,
  type AdPlacementsListResponse,
  type AdSlotScheduleResponse,
  type AdSlotSchedulesListResponse,
  type ListAdSlotSchedulesQuery,
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
 * Admin slot-inventory management BFF proxy (TS-272a; PRD §10.9; PDD §18.1).
 *
 *   GET    /api/v1/admin/ads/placements                       — seeded slots
 *   GET    /api/v1/admin/ads/slot-schedules                   — list (filtered)
 *   POST   /api/v1/admin/ads/slot-schedules                   — book a campaign into a slot
 *   GET    /api/v1/admin/ads/slot-schedules/:scheduleId       — detail
 *   PATCH  /api/v1/admin/ads/slot-schedules/:scheduleId       — window / priority / status
 *
 * Forwards to service-ads's identical surface (TS-272a) at the SAME path.
 *
 * **Authorisation.** All endpoints sit behind three guards (in order):
 *   1. `AccessTokenGuard` — verify the JWT + attach RequestContext.
 *   2. `PermissionGuard`  — `ads:read` for the reads, `ads:write` for the mutations.
 *   3. `RateLimitGuard`   — apply the default policy.
 * service-ads ALSO enforces the same permission gate (defence-in-depth). The
 * acting admin's identity propagates via the signed trust-header envelope the
 * `DownstreamHttpClient` mints (`actor: ctx`); the actor id is never read from
 * the body.
 *
 * **Idempotency-Key.** The POST / PATCH proxies forward the inbound
 * `Idempotency-Key` header so a client-side retry collapses against
 * service-ads's `@Idempotent()` cached response.
 *
 * Sibling of the TS-271b ad-campaigns proxy — both gate on `PermissionGuard`.
 */
@Controller('api/v1/admin/ads')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminAdsSlotsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get('placements')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ads:read')
  async listPlacements(@Req() request: RequestWithContext): Promise<AdPlacementsListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'ads',
      path: '/api/v1/admin/ads/placements',
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, AdPlacementsListResponseSchema, 'admin-ads-placements-list', traceId);
  }

  @Get('slot-schedules')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ads:read')
  async listSchedules(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AdSlotSchedulesListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ListAdSlotSchedulesQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Ad slot-schedules list query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'ads',
      path: buildListPath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      AdSlotSchedulesListResponseSchema,
      'admin-ads-slot-schedules-list',
      traceId,
    );
  }

  @Post('slot-schedules')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('ads:write')
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AdSlotScheduleResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = CreateAdSlotScheduleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Ad slot-schedule create payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'ads',
      path: '/api/v1/admin/ads/slot-schedules',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      AdSlotScheduleResponseSchema,
      'admin-ads-slot-schedule-create',
      traceId,
    );
  }

  @Get('slot-schedules/:scheduleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ads:read')
  async detail(
    @Param('scheduleId') scheduleId: string,
    @Req() request: RequestWithContext,
  ): Promise<AdSlotScheduleResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'ads',
      path: `/api/v1/admin/ads/slot-schedules/${encodeURIComponent(scheduleId)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      AdSlotScheduleResponseSchema,
      'admin-ads-slot-schedule-detail',
      traceId,
    );
  }

  @Patch('slot-schedules/:scheduleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ads:write')
  async update(
    @Param('scheduleId') scheduleId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AdSlotScheduleResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = UpdateAdSlotScheduleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Ad slot-schedule update payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'ads',
      path: `/api/v1/admin/ads/slot-schedules/${encodeURIComponent(scheduleId)}`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      AdSlotScheduleResponseSchema,
      'admin-ads-slot-schedule-update',
      traceId,
    );
  }
}

/**
 * Rebuild the downstream query string from the validated query — a
 * defence-in-depth allow-list so a smuggled param can't ride through to
 * service-ads.
 */
function buildListPath(query: ListAdSlotSchedulesQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  if (query.placementId !== undefined) params.set('placementId', query.placementId);
  if (query.campaignId !== undefined) params.set('campaignId', query.campaignId);
  if (query.status !== undefined) params.set('status', query.status);
  return `/api/v1/admin/ads/slot-schedules?${params.toString()}`;
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
          detail: `Downstream service-ads returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-ads returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-ads did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-ads is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure ADS_SERVICE_BASE_URL.`,
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
