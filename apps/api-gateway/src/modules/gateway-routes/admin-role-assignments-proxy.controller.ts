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
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  AdminRoleAssignmentResponseSchema,
  AdminRoleAssignmentsListQuerySchema,
  AdminRoleAssignmentsListResponseSchema,
  BulkRoleAssignmentsCommitRequestSchema,
  BulkRoleAssignmentsCommitResponseSchema,
  BulkRoleAssignmentsPreviewRequestSchema,
  BulkRoleAssignmentsPreviewResponseSchema,
  GrantRoleAssignmentRequestSchema,
  RevokeRoleAssignmentRequestSchema,
  RevokeRoleAssignmentResponseSchema,
  type AdminRoleAssignmentResponse,
  type AdminRoleAssignmentsListQuery,
  type AdminRoleAssignmentsListResponse,
  type BulkRoleAssignmentsCommitResponse,
  type BulkRoleAssignmentsPreviewResponse,
  type RevokeRoleAssignmentResponse,
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
 * Admin RBAC role-ASSIGNMENT BFF proxy (TS-292; PRD §10.12; PDD §10.3).
 *
 *   GET  /api/v1/admin/users/:userId/role-assignments   — per-user list
 *   POST /api/v1/admin/role-assignments                 — single grant
 *   POST /api/v1/admin/role-assignments/:id/revoke      — revoke
 *   POST /api/v1/admin/role-assignments/bulk-preview    — per-row validation (read-only)
 *   POST /api/v1/admin/role-assignments/bulk-commit     — partial-success apply
 *
 * Forwards to service-identity's identical surface at the SAME paths.
 * Mirrors the admin-roles proxy (TS-290): `rbac:read` for reads +
 * bulk-preview, `rbac:write` for mutations — enforced here AND
 * downstream (defence-in-depth); payloads contract-validated in both
 * directions; Idempotency-Key forwarded on the mutating writes.
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminRoleAssignmentsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get('api/v1/admin/users/:userId/role-assignments')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async listForUser(
    @Param('userId') userId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleAssignmentsListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = AdminRoleAssignmentsListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Role-assignments list query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: buildListPath(userId, parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      AdminRoleAssignmentsListResponseSchema,
      'admin-role-assignments-list',
      traceId,
    );
  }

  @Post('api/v1/admin/role-assignments')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('rbac:write')
  async grant(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleAssignmentResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = GrantRoleAssignmentRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Role-assignment grant payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: '/api/v1/admin/role-assignments',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });
    return mapResult(
      result,
      AdminRoleAssignmentResponseSchema,
      'admin-role-assignment-grant',
      traceId,
    );
  }

  @Post('api/v1/admin/role-assignments/bulk-preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async bulkPreview(
    @Body() body: unknown,
    @Req() request: RequestWithContext,
  ): Promise<BulkRoleAssignmentsPreviewResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = BulkRoleAssignmentsPreviewRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Bulk preview payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: '/api/v1/admin/role-assignments/bulk-preview',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      // idempotency: a read wearing POST. The route is gated `rbac:read` and
      // returns what a bulk grant *would* do — it commits nothing, so a replay
      // has nothing to collapse. The commit half (`/bulk-commit`) forwards.
      idempotencyKey: undefined,
      traceId,
    });
    return mapResult(
      result,
      BulkRoleAssignmentsPreviewResponseSchema,
      'admin-role-assignments-bulk-preview',
      traceId,
    );
  }

  @Post('api/v1/admin/role-assignments/bulk-commit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:write')
  async bulkCommit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<BulkRoleAssignmentsCommitResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = BulkRoleAssignmentsCommitRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Bulk commit payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: '/api/v1/admin/role-assignments/bulk-commit',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });
    return mapResult(
      result,
      BulkRoleAssignmentsCommitResponseSchema,
      'admin-role-assignments-bulk-commit',
      traceId,
    );
  }

  @Post('api/v1/admin/role-assignments/:assignmentId/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:write')
  async revoke(
    @Param('assignmentId') assignmentId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<RevokeRoleAssignmentResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = RevokeRoleAssignmentRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw badRequest('Role-assignment revoke payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: `/api/v1/admin/role-assignments/${encodeURIComponent(assignmentId)}/revoke`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });
    return mapResult(
      result,
      RevokeRoleAssignmentResponseSchema,
      'admin-role-assignment-revoke',
      traceId,
    );
  }
}

/**
 * Build the downstream list path from the contract-allow-listed query
 * fields — only fields the schema accepted are forwarded.
 */
function buildListPath(userId: string, query: AdminRoleAssignmentsListQuery): string {
  const base = `/api/v1/admin/users/${encodeURIComponent(userId)}/role-assignments`;
  if (query.includeInactive !== true) return base;
  return `${base}?includeInactive=true`;
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
          detail: `Downstream service-identity returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-identity returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-identity did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-identity is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure IDENTITY_SERVICE_BASE_URL.`,
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
