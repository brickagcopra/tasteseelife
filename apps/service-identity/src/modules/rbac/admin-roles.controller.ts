import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Patch,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ADMIN_ROLES_ROLE_ID_MAX_LENGTH,
  AdminPermissionsListResponseSchema,
  AdminRoleResponseSchema,
  AdminRolesListQuerySchema,
  AdminRolesListResponseSchema,
  ArchiveAdminRoleRequestSchema,
  CreateAdminRoleRequestSchema,
  UpdateAdminRoleRequestSchema,
  type AdminPermissionsListResponse,
  type AdminRoleRecord,
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
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { RoleCatalogService, type RoleCatalogRow } from './role-catalog.service';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { buildAuditActorContext } from '@taste-and-see/nest-audit';

/**
 * Admin RBAC role-catalog HTTP boundary (TS-290; PRD §10.12; PDD §10.3).
 *
 *   GET   /api/v1/admin/permissions          — permission catalog (rbac:read)
 *   GET   /api/v1/admin/roles                — list, ?includeArchived (rbac:read)
 *   GET   /api/v1/admin/roles/:roleId        — detail (rbac:read)
 *   POST  /api/v1/admin/roles                — create custom role (rbac:write)
 *   PATCH /api/v1/admin/roles/:roleId        — partial update (rbac:write)
 *   POST  /api/v1/admin/roles/:roleId/archive — soft-archive (rbac:write)
 *
 * **Authorisation.** First identity controller on `PermissionGuard` +
 * `@RequirePermissions(...)` (granular per-permission gating) rather
 * than the hard-wired `SuperAdminRoleGuard` — the `rbac:read` /
 * `rbac:write` permissions land on the seed catalog with this task.
 * Guard order matters: `AccessTokenGuard` populates
 * `request.requestContext`; `PermissionGuard` evaluates the token's
 * denormalised `roles[*].permissions` claim against the decorator.
 * The api-gateway proxy re-enforces the same gate at the edge
 * (defence-in-depth).
 *
 * **System roles are read-only.** Mutations on `isSystem` rows are
 * rejected with 409 in `RoleCatalogService` — the seed catalog owns
 * them.
 *
 * **Audit emission.** Every mutation emits a durable
 * `audit.action_recorded` outbox event in-tx (TS-295) — the controller
 * builds the actor context from the VERIFIED token + request metadata
 * and hands it to the service, which emits via `AuditEmitter`.
 *
 * **Idempotency.** GETs are naturally idempotent. Each mutation wears
 * `@Idempotent()` so a retried admin click replays the cached
 * response (CLAUDE.md §3.3); the gateway proxy forwards the inbound
 * Idempotency-Key header through.
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard)
export class AdminRolesController {
  constructor(private readonly catalog: RoleCatalogService) {}

  @Get('api/v1/admin/permissions')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async listPermissions(): Promise<AdminPermissionsListResponse> {
    const permissions = await this.catalog.listPermissions();
    const response: AdminPermissionsListResponse = {
      permissions: permissions.map((p) => ({
        id: p.id,
        resource: p.resource,
        action: p.action,
        description: p.description,
      })),
    };
    // Parse-validate before returning so a drift between the service
    // shape and the contract surfaces at the boundary (repo idiom).
    return AdminPermissionsListResponseSchema.parse(response);
  }

  @Get('api/v1/admin/roles')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async listRoles(
    @Query(new ZodValidationPipe(AdminRolesListQuerySchema)) query: AdminRolesListQuery,
  ): Promise<AdminRolesListResponse> {
    const roles = await this.catalog.listRoles({
      includeArchived: query.includeArchived ?? false,
    });
    const response: AdminRolesListResponse = { roles: roles.map(roleRowToDto) };
    return AdminRolesListResponseSchema.parse(response);
  }

  @Get('api/v1/admin/roles/:roleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async getRole(@Param('roleId') roleId: string): Promise<AdminRoleResponse> {
    if (roleId.length === 0 || roleId.length > ADMIN_ROLES_ROLE_ID_MAX_LENGTH) {
      throw notFound(roleId);
    }
    const role = await this.catalog.getRole(roleId);
    if (role === null) throw notFound(roleId);
    return AdminRoleResponseSchema.parse({ role: roleRowToDto(role) });
  }

  @Post('api/v1/admin/roles')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('rbac:write')
  @Idempotent()
  async createRole(
    @Body(new ZodValidationPipe(CreateAdminRoleRequestSchema)) body: CreateAdminRoleRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleResponse> {
    const actor = requireAuditActor(request);
    const role = await this.catalog.createRole({
      name: body.name,
      ...(body.description !== undefined ? { description: body.description } : {}),
      permissions: body.permissions,
      actor,
    });
    return AdminRoleResponseSchema.parse({ role: roleRowToDto(role) });
  }

  @Patch('api/v1/admin/roles/:roleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:write')
  @Idempotent()
  async updateRole(
    @Param('roleId') roleId: string,
    @Body(new ZodValidationPipe(UpdateAdminRoleRequestSchema)) body: UpdateAdminRoleRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleResponse> {
    if (roleId.length === 0 || roleId.length > ADMIN_ROLES_ROLE_ID_MAX_LENGTH) {
      throw notFound(roleId);
    }
    const actor = requireAuditActor(request);
    const role = await this.catalog.updateRole({
      roleId,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
      actor,
    });
    return AdminRoleResponseSchema.parse({ role: roleRowToDto(role) });
  }

  @Post('api/v1/admin/roles/:roleId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:write')
  @Idempotent()
  async archiveRole(
    @Param('roleId') roleId: string,
    @Body(new ZodValidationPipe(ArchiveAdminRoleRequestSchema)) body: ArchiveAdminRoleRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleResponse> {
    if (roleId.length === 0 || roleId.length > ADMIN_ROLES_ROLE_ID_MAX_LENGTH) {
      throw notFound(roleId);
    }
    const actor = requireAuditActor(request);
    const role = await this.catalog.archiveRole({
      roleId,
      ...(body.note !== undefined ? { note: body.note } : {}),
      actor,
    });
    return AdminRoleResponseSchema.parse({ role: roleRowToDto(role) });
  }
}

/** Project a service-layer role row onto the wire DTO. */
function roleRowToDto(row: RoleCatalogRow): AdminRoleRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    permissions: [...row.permissions],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Build the audit actor context from the VERIFIED token's request
 * context + the request metadata (TS-295; CLAUDE.md §3.6).
 */
function requireAuditActor(request: RequestWithContext): AuditActorContext {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    // Defence in depth — AccessTokenGuard already attached the
    // context; reaching here without one is a misconfiguration.
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return buildAuditActorContext(ctx, request);
}

function notFound(roleId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: `Role ${roleId.length <= 32 ? roleId : `${roleId.slice(0, 29)}...`} not found.`,
  });
}
