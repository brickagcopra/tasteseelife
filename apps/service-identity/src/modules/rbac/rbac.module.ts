import { Module } from '@nestjs/common';

import { AdminOrgSecurityPoliciesController } from './admin-org-security-policies.controller';
import { AdminRbacCatalogController } from './admin-rbac-catalog.controller';
import { AdminRoleApprovalsController } from './admin-role-approvals.controller';
import { AdminRoleAssignmentsController } from './admin-role-assignments.controller';
import { AdminRolesController } from './admin-roles.controller';
import { OrgSecurityPolicyService } from './org-security-policy.service';
import { RbacCatalogPortService } from './rbac-catalog-port.service';
import { RbacApprovalEmitter } from './rbac-approval-emitter';
import { RbacExpiryEmitter } from './rbac-expiry-emitter';
import { RbacRevokerMetrics } from './rbac-revoker-metrics';
import { RbacRevokerRunner } from './rbac-revoker.runner';
import { RoleAssignmentAdminService } from './role-assignment-admin.service';
import { RoleAssignmentApprovalService } from './role-assignment-approval.service';
import { RoleAssignmentExpiryService } from './role-assignment-expiry.service';
import { RoleAssignmentService } from './role-assignment.service';
import { RoleCatalogService } from './role-catalog.service';

/**
 * RBAC bounded module — owns the role-assignment surface introduced
 * by TS-024 (PDD §10.2 / Appendix B; CLAUDE.md §3.2).
 *
 * The seed catalog (`seedRbacCatalog`) is intentionally NOT wired
 * into the module's bootstrap lifecycle — Phase 1 services are
 * deployed as multiple replicas and running the seed at every
 * `onApplicationBootstrap` would race across replicas. The seed
 * runs as a one-shot via `pnpm seed:rbac` (the CLI entry-point in
 * `src/scripts/seed-rbac.ts`) before a release rolls. That same
 * binary can also be wrapped in a Kubernetes Job for staging /
 * prod (TS-152 ArgoCD bootstrap).
 *
 * Exports `RoleAssignmentService` so `AuthModule` can pull active
 * assignments at session-issue time (CLAUDE.md §3.2 — roles flow
 * from RBAC into the access token's claims).
 *
 * TS-290 adds the role-DEFINITION management surface:
 * `RoleCatalogService` (CRUD over roles / role_permissions, with
 * seed-owned system roles read-only) and `AdminRolesController`
 * (`/api/v1/admin/roles` + `/api/v1/admin/permissions`, gated
 * `rbac:read` / `rbac:write` via `PermissionGuard` — the first
 * identity controller on granular permission gating).
 *
 * TS-292 adds the role-ASSIGNMENT surface:
 * `RoleAssignmentAdminService` (policy layer — sensitive-role
 * rejection, per-row bulk validation, partial-success commit) and
 * `AdminRoleAssignmentsController`
 * (`/api/v1/admin/role-assignments` + the per-user list, same
 * `rbac:read` / `rbac:write` gating).
 *
 * TS-293 adds the expiry sweep (queue name `rbac-revoker`):
 * `RoleAssignmentExpiryService` (batched revoke-where-expired +
 * per-row outbox event — identity's first outbox producer) driven
 * by `RbacRevokerRunner` (BullMQ job scheduler on the shared
 * REDIS_URL; one sweep per interval cluster-wide). The worker lives
 * HERE rather than a standalone `apps/workers/*` app because the
 * sweep needs identity's Prisma client — a separate app would
 * either violate the cross-service DB prohibition (CLAUDE.md §2.3)
 * or demand an internal bulk-revoke API with no other caller. Since
 * TS-308a-followup-1 the queue/worker lifecycle itself comes from the
 * `@Global()` `@taste-and-see/nest-bullmq-scheduler` module (hence no
 * import line here), which keeps the handles behind an injectable
 * factory so unit tests never open Redis connections.
 *
 * TS-294 adds the reviewer-required grant flow for sensitive roles:
 * `RoleAssignmentApprovalService` (pending-request rows on the
 * TS-024-followup-4 model; the grant is only minted on a SECOND
 * admin's approval, and the approver must hold super_admin) and
 * `AdminRoleApprovalsController` (`/api/v1/admin/role-approvals`).
 * Flow events ride `RbacApprovalEmitter` → `identity.outbox_events`.
 *
 * TS-295 adds durable audit emission: every RBAC mutation (catalog
 * CRUD, grants/revokes/bulk, approval flow, expiry sweep) emits an
 * `audit.action_recorded` outbox event in-tx via `AuditEmitter`
 * (the RBAC slice of TS-126-followup-5); `service-audit` persists it
 * append-only + hash-chained and serves the RBAC History view's
 * by-resource-kind read.
 *
 * TS-296 adds org security policies: `OrgSecurityPolicyService`
 * (flags keyed by tenant scope id / the `'global'` sentinel —
 * `ssoRequired` gates admin-staff session issuance) and
 * `AdminOrgSecurityPoliciesController`
 * (`/api/v1/admin/org-security-policies`, same `rbac:read` /
 * `rbac:write` gating; upserts audit-emit in-tx). Exported so
 * `AuthService.issueSessionFor` can enforce the SSO gate at the
 * single session-minting choke point.
 *
 * TS-299 adds catalog import/export: `RbacCatalogPortService`
 * (portable id-free envelope; import shares the seed's
 * `applyRbacCatalog` reconcile core, never deletes, audit-emits per
 * changed role, refuses system-role changes without an explicit allow
 * flag) and `AdminRbacCatalogController` (`GET /api/v1/admin/
 * rbac-catalog/export`, `rbac:read`). Import is CLI-only
 * (`src/scripts/rbac-catalog.ts` / `pnpm rbac:catalog`) — see the
 * service doc for why it has no HTTP surface.
 */
@Module({
  controllers: [
    AdminRolesController,
    AdminRoleAssignmentsController,
    AdminRoleApprovalsController,
    AdminOrgSecurityPoliciesController,
    AdminRbacCatalogController,
  ],
  providers: [
    RoleAssignmentService,
    RoleCatalogService,
    RoleAssignmentAdminService,
    RbacApprovalEmitter,
    RoleAssignmentApprovalService,
    RbacExpiryEmitter,
    RoleAssignmentExpiryService,
    RbacRevokerMetrics,
    RbacRevokerRunner,
    OrgSecurityPolicyService,
    RbacCatalogPortService,
  ],
  exports: [RoleAssignmentService, OrgSecurityPolicyService],
})
export class RbacModule {}
