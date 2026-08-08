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
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  AcademyCohortResponseSchema,
  AcademyCohortsListResponseSchema,
  CreateAcademyCohortRequestSchema,
  ListAcademyCohortsQuerySchema,
  UpdateAcademyCohortRequestSchema,
  type AcademyCohortResponse,
  type AcademyCohortsListResponse,
  type ListAcademyCohortsQuery,
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
 * Admin Cooking-Academy cohort BFF proxy (TS-251; PRD §9.1, §9.5; PDD §15.1).
 *
 *   GET    /api/v1/admin/academy/courses/:courseId/cohorts — list (course's cohorts)
 *   POST   /api/v1/admin/academy/courses/:courseId/cohorts — schedule a cohort
 *   PATCH  /api/v1/admin/academy/cohorts/:cohortId         — update
 *   DELETE /api/v1/admin/academy/cohorts/:cohortId         — soft-delete (tombstone)
 *
 * Forwards to service-academy's identical surface at the SAME path. The
 * controller is rooted at `api/v1/admin/academy` because the list/create live
 * under `courses/:courseId/cohorts` while the update/delete live under
 * `cohorts/:cohortId`.
 *
 * **Authorisation.** All endpoints sit behind three guards (in order):
 * `AccessTokenGuard` → `PermissionGuard` (`academy:read` for the list,
 * `academy:write` for the mutations) → `RateLimitGuard` (default policy).
 * service-academy ALSO enforces the gate (defence-in-depth).
 *
 * **Idempotency-Key.** The POST / PATCH / DELETE proxies forward the inbound
 * `Idempotency-Key` header so a client-side retry collapses against
 * service-academy's `@Idempotent()` cached response.
 */
@Controller('api/v1/admin/academy')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminAcademyCohortsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get('courses/:courseId/cohorts')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:read')
  async list(
    @Param('courseId') courseId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCohortsListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ListAcademyCohortsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Academy cohorts query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'academy',
      path: buildListPath(courseId, parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      AcademyCohortsListResponseSchema,
      'admin-academy-cohorts-list',
      traceId,
    );
  }

  @Post('courses/:courseId/cohorts')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('academy:write')
  async create(
    @Param('courseId') courseId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCohortResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = CreateAcademyCohortRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Academy cohort create payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'academy',
      path: `/api/v1/admin/academy/courses/${encodeURIComponent(courseId)}/cohorts`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, AcademyCohortResponseSchema, 'admin-academy-cohort-create', traceId);
  }

  @Patch('cohorts/:cohortId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  async update(
    @Param('cohortId') cohortId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCohortResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = UpdateAcademyCohortRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Academy cohort update payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'academy',
      path: `/api/v1/admin/academy/cohorts/${encodeURIComponent(cohortId)}`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, AcademyCohortResponseSchema, 'admin-academy-cohort-update', traceId);
  }

  @Delete('cohorts/:cohortId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  async remove(
    @Param('cohortId') cohortId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCohortResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'academy',
      path: `/api/v1/admin/academy/cohorts/${encodeURIComponent(cohortId)}`,
      method: 'DELETE',
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, AcademyCohortResponseSchema, 'admin-academy-cohort-delete', traceId);
  }
}

/**
 * Rebuild the downstream query string from the validated query — a
 * defence-in-depth allow-list so a smuggled param can't ride through to
 * service-academy.
 */
function buildListPath(courseId: string, query: ListAcademyCohortsQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  if (query.status !== undefined) params.set('status', query.status);
  if (query.includeDeleted !== undefined)
    params.set('includeDeleted', String(query.includeDeleted));
  return `/api/v1/admin/academy/courses/${encodeURIComponent(courseId)}/cohorts?${params.toString()}`;
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
          detail: `Downstream service-academy returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-academy returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-academy did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-academy is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure ACADEMY_SERVICE_BASE_URL.`,
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
