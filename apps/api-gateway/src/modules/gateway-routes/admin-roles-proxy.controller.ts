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
  AdminPermissionsListResponseSchema,
  AdminRoleResponseSchema,
  AdminRolesListQuerySchema,
  AdminRolesListResponseSchema,
  ArchiveAdminRoleRequestSchema,
  CreateAdminRoleRequestSchema,
  UpdateAdminRoleRequestSchema,
  type AdminPermissionsListResponse,
  type AdminRoleResponse,
  type AdminRolesListQuery,
  type AdminRolesListResponse,
  type ArchiveAdminRoleRequest,
  type CreateAdminRoleRequest,
  type UpdateAdminRoleRequest,
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
 * Admin RBAC role-catalog BFF proxy (TS-290; PRD §10.12; PDD §10.3).
 *
 *   GET   /api/v1/admin/permissions           — permission catalog
 *   GET   /api/v1/admin/roles                 — list (?includeArchived)
 *   GET   /api/v1/admin/roles/:roleId         — detail
 *   POST  /api/v1/admin/roles                 — create custom role
 *   PATCH /api/v1/admin/roles/:roleId         — partial update
 *   POST  /api/v1/admin/roles/:roleId/archive — soft-archive
 *
 * Forwards to service-identity's identical surface at the SAME paths.
 * Permission pair mirrors the downstream: `rbac:read` for reads,
 * `rbac:write` for mutations — enforced here via `PermissionGuard`
 * AND re-enforced downstream (defence-in-depth). Idempotency-Key is
 * forwarded on writes so the downstream `@Idempotent()` interceptor
 * can collapse client retries. Payloads are contract-validated in
 * both directions (allow-listed inbound, parse-checked outbound).
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminRolesProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get('api/v1/admin/permissions')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async listPermissions(@Req() request: RequestWithContext): Promise<AdminPermissionsListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: '/api/v1/admin/permissions',
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, AdminPermissionsListResponseSchema, 'admin-permissions-list', traceId);
  }

  @Get('api/v1/admin/roles')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async listRoles(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AdminRolesListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = AdminRolesListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Roles list query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: buildListPath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, AdminRolesListResponseSchema, 'admin-roles-list', traceId);
  }

  @Get('api/v1/admin/roles/:roleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async getRole(
    @Param('roleId') roleId: string,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: `/api/v1/admin/roles/${encodeURIComponent(roleId)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, AdminRoleResponseSchema, 'admin-role-detail', traceId);
  }

  @Post('api/v1/admin/roles')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('rbac:write')
  async createRole(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = CreateAdminRoleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Role create payload failed validation.', parsed.error.issues);
    }

    return this.callMutation({
      ctx,
      path: '/api/v1/admin/roles',
      method: 'POST',
      body: parsed.data,
      idempotencyKey,
      surface: 'admin-role-create',
      traceId,
    });
  }

  @Patch('api/v1/admin/roles/:roleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:write')
  async updateRole(
    @Param('roleId') roleId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = UpdateAdminRoleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Role update payload failed validation.', parsed.error.issues);
    }

    return this.callMutation({
      ctx,
      path: `/api/v1/admin/roles/${encodeURIComponent(roleId)}`,
      method: 'PATCH',
      body: parsed.data,
      idempotencyKey,
      surface: 'admin-role-update',
      traceId,
    });
  }

  @Post('api/v1/admin/roles/:roleId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:write')
  async archiveRole(
    @Param('roleId') roleId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ArchiveAdminRoleRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw badRequest('Role archive payload failed validation.', parsed.error.issues);
    }

    return this.callMutation({
      ctx,
      path: `/api/v1/admin/roles/${encodeURIComponent(roleId)}/archive`,
      method: 'POST',
      body: parsed.data,
      idempotencyKey,
      surface: 'admin-role-archive',
      traceId,
    });
  }

  private async callMutation(args: {
    readonly ctx: NonNullable<RequestWithContext['requestContext']>;
    readonly path: string;
    readonly method: 'POST' | 'PATCH';
    readonly body: CreateAdminRoleRequest | UpdateAdminRoleRequest | ArchiveAdminRoleRequest;
    readonly idempotencyKey: string | undefined;
    readonly surface: string;
    readonly traceId: string | undefined;
  }): Promise<AdminRoleResponse> {
    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: args.path,
      method: args.method,
      body: args.body,
      actor: args.ctx,
      traceId: args.traceId,
      idempotencyKey: args.idempotencyKey,
    });
    return mapResult(result, AdminRoleResponseSchema, args.surface, args.traceId);
  }
}

/**
 * Build the downstream list path from the contract-allow-listed query
 * fields — only fields the schema accepted are forwarded.
 */
function buildListPath(query: AdminRolesListQuery): string {
  if (query.includeArchived !== true) return '/api/v1/admin/roles';
  return '/api/v1/admin/roles?includeArchived=true';
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
