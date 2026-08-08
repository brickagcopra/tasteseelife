import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  OrgSecurityPoliciesListResponseSchema,
  OrgSecurityPolicyResponseSchema,
  OrgSecurityPolicyScopeIdSchema,
  UpsertOrgSecurityPolicyRequestSchema,
  type OrgSecurityPoliciesListResponse,
  type OrgSecurityPolicyRecord,
  type OrgSecurityPolicyResponse,
  type UpsertOrgSecurityPolicyRequest,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { OrgSecurityPolicyService, type OrgSecurityPolicyRow } from './org-security-policy.service';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { buildAuditActorContext } from '@taste-and-see/nest-audit';

/**
 * Org security-policy HTTP boundary (TS-296; CLAUDE.md §3.1; PDD §10.1).
 *
 *   GET /api/v1/admin/org-security-policies           — list (rbac:read)
 *   PUT /api/v1/admin/org-security-policies/:scopeId  — upsert (rbac:write)
 *
 * This surface configures who can obtain an admin session
 * (`ssoRequired` gates admin-staff logins), so it sits on the same
 * `rbac:read` / `rbac:write` trust boundary as the role catalog — no
 * new permission, no seed re-run. The api-gateway proxy re-enforces
 * the same gate at the edge (defence-in-depth).
 *
 * PUT is upsert (absent row = default-off policy) and naturally
 * idempotent; `@Idempotent()` additionally replays the cached
 * response on a retried operator click (CLAUDE.md §3.3).
 *
 * Every effective upsert emits `audit.action_recorded` in-tx (TS-295
 * invariant) — the controller builds the actor context from the
 * VERIFIED token + request metadata.
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard)
export class AdminOrgSecurityPoliciesController {
  constructor(private readonly policies: OrgSecurityPolicyService) {}

  @Get('api/v1/admin/org-security-policies')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async listPolicies(): Promise<OrgSecurityPoliciesListResponse> {
    const rows = await this.policies.listPolicies();
    const response: OrgSecurityPoliciesListResponse = {
      policies: rows.map(policyRowToDto),
    };
    // Parse-validate before returning so a drift between the service
    // shape and the contract surfaces at the boundary (repo idiom).
    return OrgSecurityPoliciesListResponseSchema.parse(response);
  }

  @Put('api/v1/admin/org-security-policies/:scopeId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:write')
  @Idempotent()
  async upsertPolicy(
    @Param('scopeId') scopeId: string,
    @Body(new ZodValidationPipe(UpsertOrgSecurityPolicyRequestSchema))
    body: UpsertOrgSecurityPolicyRequest,
    @Req() request: RequestWithContext,
  ): Promise<OrgSecurityPolicyResponse> {
    const parsedScope = OrgSecurityPolicyScopeIdSchema.safeParse(scopeId);
    if (!parsedScope.success) {
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'scopeId must be a bounded token (letters, digits, "_", "-").',
      });
    }
    const actor = requireAuditActor(request);
    const row = await this.policies.upsertPolicy({
      scopeId: parsedScope.data,
      ssoRequired: body.ssoRequired,
      actor,
    });
    return OrgSecurityPolicyResponseSchema.parse({ policy: policyRowToDto(row) });
  }
}

/** Project a service-layer policy row onto the wire DTO. */
function policyRowToDto(row: OrgSecurityPolicyRow): OrgSecurityPolicyRecord {
  return {
    id: row.id,
    scopeId: row.scopeId,
    ssoRequired: row.ssoRequired,
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
