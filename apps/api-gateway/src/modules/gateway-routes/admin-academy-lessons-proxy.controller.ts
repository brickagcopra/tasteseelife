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
  AcademyLessonResponseSchema,
  AcademyLessonsListResponseSchema,
  CreateAcademyLessonRequestSchema,
  UpdateAcademyLessonRequestSchema,
  type AcademyLessonResponse,
  type AcademyLessonsListResponse,
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
 * Admin Cooking-Academy lesson BFF proxy (TS-251; PRD §9.1–§9.2, §9.5;
 * PDD §15.1).
 *
 *   GET    /api/v1/admin/academy/modules/:moduleId/lessons — list (module's lessons)
 *   POST   /api/v1/admin/academy/modules/:moduleId/lessons — append a lesson
 *   PATCH  /api/v1/admin/academy/lessons/:lessonId         — update
 *   DELETE /api/v1/admin/academy/lessons/:lessonId         — delete (204, no body)
 *
 * Forwards to service-academy's identical surface at the SAME path. The
 * controller is rooted at `api/v1/admin/academy` because the list/create live
 * under `modules/:moduleId/lessons` while the update/delete live under
 * `lessons/:lessonId`.
 *
 * **Authorisation.** All endpoints sit behind three guards (in order):
 * `AccessTokenGuard` → `PermissionGuard` (`academy:read` for the list,
 * `academy:write` for the mutations) → `RateLimitGuard` (default policy).
 * service-academy ALSO enforces the gate (defence-in-depth).
 *
 * **Idempotency-Key.** The POST / PATCH / DELETE proxies forward the inbound
 * `Idempotency-Key` header so a client-side retry collapses against
 * service-academy's `@Idempotent()` cached response.
 *
 * **204 DELETE.** The delete endpoint returns `204 No Content` with no body —
 * `remove()` returns `void` and maps the downstream failure kinds to the same
 * RFC 7807 errors, but never parses an `ok` body (there isn't one).
 */
@Controller('api/v1/admin/academy')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminAcademyLessonsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get('modules/:moduleId/lessons')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:read')
  async list(
    @Param('moduleId') moduleId: string,
    @Req() request: RequestWithContext,
  ): Promise<AcademyLessonsListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'academy',
      path: `/api/v1/admin/academy/modules/${encodeURIComponent(moduleId)}/lessons`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      AcademyLessonsListResponseSchema,
      'admin-academy-lessons-list',
      traceId,
    );
  }

  @Post('modules/:moduleId/lessons')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('academy:write')
  async create(
    @Param('moduleId') moduleId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AcademyLessonResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = CreateAcademyLessonRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Academy lesson create payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'academy',
      path: `/api/v1/admin/academy/modules/${encodeURIComponent(moduleId)}/lessons`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, AcademyLessonResponseSchema, 'admin-academy-lesson-create', traceId);
  }

  @Patch('lessons/:lessonId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  async update(
    @Param('lessonId') lessonId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AcademyLessonResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = UpdateAcademyLessonRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Academy lesson update payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'academy',
      path: `/api/v1/admin/academy/lessons/${encodeURIComponent(lessonId)}`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, AcademyLessonResponseSchema, 'admin-academy-lesson-update', traceId);
  }

  @Delete('lessons/:lessonId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('academy:write')
  async remove(
    @Param('lessonId') lessonId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<void> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'academy',
      path: `/api/v1/admin/academy/lessons/${encodeURIComponent(lessonId)}`,
      method: 'DELETE',
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    mapVoidResult(result, traceId);
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
      throw notConfigured(result.service, traceId);
    }
  }
}

/**
 * 204-path variant of `mapResult`: returns void on a successful (2xx)
 * downstream response — there is no body to parse — and maps every failure
 * kind to the same RFC 7807 error as the body-bearing surfaces.
 */
function mapVoidResult(result: DownstreamResult, traceId: string | undefined): void {
  switch (result.kind) {
    case 'ok':
      return;
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
      throw notConfigured(result.service, traceId);
    }
  }
}

function notConfigured(service: string, traceId: string | undefined): ServiceUnavailableException {
  return new ServiceUnavailableException({
    type: 'about:blank',
    title: 'Service Unavailable',
    status: HttpStatus.SERVICE_UNAVAILABLE,
    detail: `Gateway has no route for the '${service}' service. Configure ACADEMY_SERVICE_BASE_URL.`,
    ...(traceId !== undefined && { traceId }),
  });
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
