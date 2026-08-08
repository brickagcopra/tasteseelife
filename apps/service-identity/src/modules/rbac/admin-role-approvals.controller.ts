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
  AdminRoleApprovalResponseSchema,
  AdminRoleApprovalsListQuerySchema,
  AdminRoleApprovalsListResponseSchema,
  DecideRoleApprovalRequestSchema,
  RequestRoleApprovalRequestSchema,
  type AdminRoleApprovalResponse,
  type AdminRoleApprovalsListQuery,
  type AdminRoleApprovalsListResponse,
  type DecideRoleApprovalRequest,
  type RequestRoleApprovalRequest,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { RoleAssignmentApprovalService } from './role-assignment-approval.service';
import { buildAuditActorContext } from '@taste-and-see/nest-audit';

/**
 * Admin RBAC role-APPROVAL HTTP boundary (TS-294; CLAUDE.md §3.2).
 *
 *   POST /api/v1/admin/role-approvals              (rbac:write) — request
 *   GET  /api/v1/admin/role-approvals?status=      (rbac:read)  — queue / history
 *   POST /api/v1/admin/role-approvals/:id/approve  (rbac:write)
 *   POST /api/v1/admin/role-approvals/:id/reject   (rbac:write)
 *
 * Guard stack as the sibling RBAC controllers (TS-290/292). The
 * decorator gate is `rbac:write`; approve / reject carry an ADDITIONAL
 * service-layer check that the decider holds an active `super_admin`
 * assignment (see `RoleAssignmentApprovalService` — `rbac:write` alone
 * approving a super_admin grant would be an escalation hole), and
 * approve rejects the requester deciding their own request. All three
 * mutations are `@Idempotent()`.
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard)
export class AdminRoleApprovalsController {
  constructor(private readonly approvals: RoleAssignmentApprovalService) {}

  @Get('api/v1/admin/role-approvals')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async list(
    @Query(new ZodValidationPipe(AdminRoleApprovalsListQuerySchema))
    query: AdminRoleApprovalsListQuery,
  ): Promise<AdminRoleApprovalsListResponse> {
    const approvals = await this.approvals.list(
      query.status !== undefined ? { status: query.status } : {},
    );
    return AdminRoleApprovalsListResponseSchema.parse({ approvals: [...approvals] });
  }

  @Post('api/v1/admin/role-approvals')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('rbac:write')
  @Idempotent()
  async request(
    @Body(new ZodValidationPipe(RequestRoleApprovalRequestSchema))
    body: RequestRoleApprovalRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleApprovalResponse> {
    const ctx = requireContext(request);
    const approval = await this.approvals.requestGrant({
      userId: body.userId,
      roleName: body.roleName,
      scope: body.scope,
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
      reason: body.reason,
      actor: buildAuditActorContext(ctx, request),
    });
    return AdminRoleApprovalResponseSchema.parse({ approval });
  }

  @Post('api/v1/admin/role-approvals/:approvalId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:write')
  @Idempotent()
  async approve(
    @Param('approvalId') approvalId: string,
    @Body(new ZodValidationPipe(DecideRoleApprovalRequestSchema))
    body: DecideRoleApprovalRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleApprovalResponse> {
    const ctx = requireContext(request);
    requireParamId(approvalId);
    const approval = await this.approvals.approve({
      approvalId,
      actor: buildAuditActorContext(ctx, request),
      actorRoleNames: ctx.roles.map((r) => r.name),
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
    return AdminRoleApprovalResponseSchema.parse({ approval });
  }

  @Post('api/v1/admin/role-approvals/:approvalId/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:write')
  @Idempotent()
  async reject(
    @Param('approvalId') approvalId: string,
    @Body(new ZodValidationPipe(DecideRoleApprovalRequestSchema))
    body: DecideRoleApprovalRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleApprovalResponse> {
    const ctx = requireContext(request);
    requireParamId(approvalId);
    const approval = await this.approvals.reject({
      approvalId,
      actor: buildAuditActorContext(ctx, request),
      actorRoleNames: ctx.roles.map((r) => r.name),
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
    return AdminRoleApprovalResponseSchema.parse({ approval });
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
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx;
}

function requireParamId(id: string): void {
  if (id.length === 0 || id.length > ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH) {
    throw new NotFoundException({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: `Approval request ${id.length <= 32 ? id : `${id.slice(0, 29)}...`} not found.`,
    });
  }
}
