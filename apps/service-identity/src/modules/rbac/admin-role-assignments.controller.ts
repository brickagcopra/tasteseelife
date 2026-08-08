import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH,
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
  type BulkRoleAssignmentsCommitRequest,
  type BulkRoleAssignmentsCommitResponse,
  type BulkRoleAssignmentsPreviewRequest,
  type BulkRoleAssignmentsPreviewResponse,
  type GrantRoleAssignmentRequest,
  type RevokeRoleAssignmentRequest,
  type RevokeRoleAssignmentResponse,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { RoleAssignmentAdminService } from './role-assignment-admin.service';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { buildAuditActorContext } from '@taste-and-see/nest-audit';

/**
 * Admin RBAC role-ASSIGNMENT HTTP boundary (TS-292; PRD §10.12; PDD §10.3).
 *
 *   GET  /api/v1/admin/users/:userId/role-assignments  (rbac:read)
 *   POST /api/v1/admin/role-assignments                (rbac:write) — single grant
 *   POST /api/v1/admin/role-assignments/:id/revoke     (rbac:write)
 *   POST /api/v1/admin/role-assignments/bulk-preview   (rbac:read)  — NO writes
 *   POST /api/v1/admin/role-assignments/bulk-commit    (rbac:write)
 *
 * Same guard stack as `AdminRolesController` (TS-290):
 * `AccessTokenGuard` populates the context, `PermissionGuard`
 * evaluates the decorator, and the api-gateway proxy re-enforces the
 * pair at the edge. bulk-preview is a POST (it carries a body) but is
 * read-only by design — it gates on `rbac:read` so a reviewer can
 * validate a sheet without grant rights, and wears no `@Idempotent()`
 * (nothing to replay). The three mutating routes are `@Idempotent()`.
 *
 * Route note: `bulk-preview` / `bulk-commit` are declared BEFORE the
 * `:assignmentId/revoke` param route so Nest matches the literal
 * segments first.
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard)
export class AdminRoleAssignmentsController {
  constructor(private readonly admin: RoleAssignmentAdminService) {}

  @Get('api/v1/admin/users/:userId/role-assignments')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async listForUser(
    @Param('userId') userId: string,
    @Query(new ZodValidationPipe(AdminRoleAssignmentsListQuerySchema))
    query: AdminRoleAssignmentsListQuery,
  ): Promise<AdminRoleAssignmentsListResponse> {
    if (userId.length === 0 || userId.length > ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH) {
      throw userNotFound(userId);
    }
    const assignments = await this.admin.listForUser(userId, {
      includeInactive: query.includeInactive ?? false,
    });
    return AdminRoleAssignmentsListResponseSchema.parse({ assignments: [...assignments] });
  }

  @Post('api/v1/admin/role-assignments')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('rbac:write')
  @Idempotent()
  async grant(
    @Body(new ZodValidationPipe(GrantRoleAssignmentRequestSchema))
    body: GrantRoleAssignmentRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleAssignmentResponse> {
    const actor = requireAuditActor(request);
    const assignment = await this.admin.grantSingle({
      userId: body.userId,
      roleName: body.roleName,
      scope: body.scope,
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      actor,
    });
    return AdminRoleAssignmentResponseSchema.parse({ assignment });
  }

  @Post('api/v1/admin/role-assignments/bulk-preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async bulkPreview(
    @Body(new ZodValidationPipe(BulkRoleAssignmentsPreviewRequestSchema))
    body: BulkRoleAssignmentsPreviewRequest,
  ): Promise<BulkRoleAssignmentsPreviewResponse> {
    const verdicts = await this.admin.bulkPreview(body.rows);
    const okCount = verdicts.filter((v) => v.ok).length;
    return BulkRoleAssignmentsPreviewResponseSchema.parse({
      verdicts: [...verdicts],
      okCount,
      errorCount: verdicts.length - okCount,
    });
  }

  @Post('api/v1/admin/role-assignments/bulk-commit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:write')
  @Idempotent()
  async bulkCommit(
    @Body(new ZodValidationPipe(BulkRoleAssignmentsCommitRequestSchema))
    body: BulkRoleAssignmentsCommitRequest,
    @Req() request: RequestWithContext,
  ): Promise<BulkRoleAssignmentsCommitResponse> {
    const actor = requireAuditActor(request);
    const outcomes = await this.admin.bulkCommit(body.rows, actor);
    return BulkRoleAssignmentsCommitResponseSchema.parse({
      outcomes: [...outcomes],
      grantedCount: outcomes.filter((o) => o.status === 'granted').length,
      conflictCount: outcomes.filter((o) => o.status === 'conflict').length,
      errorCount: outcomes.filter((o) => o.status === 'error').length,
    });
  }

  @Post('api/v1/admin/role-assignments/:assignmentId/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:write')
  @Idempotent()
  async revoke(
    @Param('assignmentId') assignmentId: string,
    @Body(new ZodValidationPipe(RevokeRoleAssignmentRequestSchema))
    body: RevokeRoleAssignmentRequest,
    @Req() request: RequestWithContext,
  ): Promise<RevokeRoleAssignmentResponse> {
    if (assignmentId.length === 0 || assignmentId.length > ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH) {
      throw assignmentNotFound(assignmentId);
    }
    const actor = requireAuditActor(request);
    const result = await this.admin.revoke({
      assignmentId,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      actor,
    });
    return RevokeRoleAssignmentResponseSchema.parse(result);
  }
}

/**
 * Build the audit actor context from the VERIFIED token's request
 * context + the request metadata (TS-295; CLAUDE.md §3.6).
 */
function requireAuditActor(request: RequestWithContext): AuditActorContext {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return buildAuditActorContext(ctx, request);
}

function userNotFound(userId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: `User ${userId.length <= 32 ? userId : `${userId.slice(0, 29)}...`} not found.`,
  });
}

function assignmentNotFound(id: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: `Role assignment ${id.length <= 32 ? id : `${id.slice(0, 29)}...`} not found.`,
  });
}
