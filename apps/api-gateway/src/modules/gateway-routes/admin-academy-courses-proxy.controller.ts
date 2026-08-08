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
  AcademyCourseDetailResponseSchema,
  AcademyCourseResponseSchema,
  AcademyCoursesListResponseSchema,
  CreateAcademyCourseRequestSchema,
  ListAcademyCoursesQuerySchema,
  UpdateAcademyCourseRequestSchema,
  type AcademyCourseDetailResponse,
  type AcademyCourseResponse,
  type AcademyCoursesListResponse,
  type ListAcademyCoursesQuery,
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
 * Admin Cooking-Academy course-catalog BFF proxy (TS-251; PRD §9.1, §9.5;
 * PDD §15.1).
 *
 *   GET    /api/v1/admin/academy/courses             — list (filtered)
 *   POST   /api/v1/admin/academy/courses             — create
 *   GET    /api/v1/admin/academy/courses/:courseId   — detail (full tree)
 *   PATCH  /api/v1/admin/academy/courses/:courseId   — update
 *   DELETE /api/v1/admin/academy/courses/:courseId   — soft-delete (tombstone)
 *
 * Forwards to service-academy's identical `/api/v1/admin/academy/courses`
 * surface at the SAME path.
 *
 * **Authorisation.** All endpoints sit behind three guards (in order):
 *   1. `AccessTokenGuard` — verify the JWT + attach RequestContext.
 *   2. `PermissionGuard`  — evaluate `@RequirePermissions(...)`:
 *      `academy:read` for the reads, `academy:write` for the mutations.
 *   3. `RateLimitGuard`   — apply the default policy.
 * service-academy ALSO enforces the same permission gate (defence-in-depth).
 * The acting admin's identity propagates via the signed trust-header envelope
 * the `DownstreamHttpClient` mints (`actor: ctx`).
 *
 * **Idempotency-Key.** The POST / PATCH / DELETE proxies forward the inbound
 * `Idempotency-Key` header so a client-side retry collapses against
 * service-academy's `@Idempotent()` cached response.
 *
 * Sibling of the TS-227 concierge scheduled-events proxy — both gate on
 * `PermissionGuard` rather than `SuperAdminRoleGuard`.
 */
@Controller('api/v1/admin/academy/courses')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminAcademyCoursesProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:read')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCoursesListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ListAcademyCoursesQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Academy courses query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'academy',
      path: buildListPath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      AcademyCoursesListResponseSchema,
      'admin-academy-courses-list',
      traceId,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('academy:write')
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCourseResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = CreateAcademyCourseRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Academy course create payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'academy',
      path: '/api/v1/admin/academy/courses',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, AcademyCourseResponseSchema, 'admin-academy-course-create', traceId);
  }

  @Get(':courseId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:read')
  async detail(
    @Param('courseId') courseId: string,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCourseDetailResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'academy',
      path: `/api/v1/admin/academy/courses/${encodeURIComponent(courseId)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      AcademyCourseDetailResponseSchema,
      'admin-academy-course-detail',
      traceId,
    );
  }

  @Patch(':courseId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  async update(
    @Param('courseId') courseId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCourseResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = UpdateAcademyCourseRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Academy course update payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'academy',
      path: `/api/v1/admin/academy/courses/${encodeURIComponent(courseId)}`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, AcademyCourseResponseSchema, 'admin-academy-course-update', traceId);
  }

  @Delete(':courseId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  async remove(
    @Param('courseId') courseId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCourseResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'academy',
      path: `/api/v1/admin/academy/courses/${encodeURIComponent(courseId)}`,
      method: 'DELETE',
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, AcademyCourseResponseSchema, 'admin-academy-course-delete', traceId);
  }
}

/**
 * Rebuild the downstream query string from the validated query — a
 * defence-in-depth allow-list so a smuggled param can't ride through to
 * service-academy.
 */
function buildListPath(query: ListAcademyCoursesQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  if (query.status !== undefined) params.set('status', query.status);
  if (query.track !== undefined) params.set('track', query.track);
  if (query.kind !== undefined) params.set('kind', query.kind);
  if (query.includeDeleted !== undefined)
    params.set('includeDeleted', String(query.includeDeleted));
  return `/api/v1/admin/academy/courses?${params.toString()}`;
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
