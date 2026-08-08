import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminImpersonationController } from './controllers/admin-impersonation.controller';
import { AdminUsersController } from './controllers/admin-users.controller';
import { AdminImpersonationService } from './services/admin-impersonation.service';
import { AdminUserActionsService } from './services/admin-user-actions.service';
import { AdminUsersService } from './services/admin-users.service';

/**
 * Admin bounded module (TS-126 Slice 1 + TS-126-followup-1 + TS-297;
 * PRD §10.2).
 *
 * Slice 1 shipped the read-only `GET /api/v1/admin/users` +
 * `GET /api/v1/admin/users/:id` surfaces. TS-126-followup-1 adds
 * three mutations: `POST /api/v1/admin/users/:id/suspend`,
 * `/reinstate`, `/unlock`. TS-297 adds the impersonation surface
 * (`POST /api/v1/admin/users/:id/impersonate` +
 * `POST /api/v1/admin/impersonation/end`). KYC document review queue
 * and background-check status surface arrive in the remaining TS-126
 * follow-ups (followup-3/-4); the portal cookie-swap flow on top of
 * impersonation is TS-126-followup-2.
 *
 * Imports `RbacModule` for the `RoleAssignmentService` (role
 * denormalisation + the impersonation admin-target check). The audit
 * emitter (impersonation start/end events, in-tx per the TS-295
 * invariant) comes from the `@Global()` `AuditModule` since
 * TS-309a-followup-3 — no import needed for it. Imports `AuthModule`
 * for `AuthService` —
 * impersonation mints through `issueSessionFor`, the single
 * session-minting choke point.
 *
 * No exports today — nothing outside this module consumes admin
 * state directly. Future admin tooling that needs cross-service
 * reads (subscriptions, bookings, accounting) will live in their
 * own per-service admin modules and aggregate at the gateway.
 */
@Module({
  imports: [RbacModule, AuthModule],
  controllers: [AdminUsersController, AdminImpersonationController],
  providers: [AdminUsersService, AdminUserActionsService, AdminImpersonationService],
})
export class AdminModule {}
