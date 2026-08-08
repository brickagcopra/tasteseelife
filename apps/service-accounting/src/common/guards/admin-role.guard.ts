import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { holdsAdminRole, isAssignmentActive } from '@taste-and-see/auth-sdk';
import type { RequestWithContext } from '@taste-and-see/nest-auth';

/**
 * Phase-1 admin gate (TS-129 Slice 1) — twin of service-identity's
 * `SuperAdminRoleGuard` (TS-126), service-subscription's (TS-127), and
 * service-booking's (TS-128). Run AFTER `AccessTokenGuard` — relies on
 * `request.requestContext` being populated.
 *
 * Enforces two policies in order:
 *
 *   1. The token's `roles[]` claim carries at least one active admin-
 *      staff role (per `auth-sdk`'s `ADMIN_ROLE_NAMES`). Otherwise the
 *      caller is authenticated but not staff — bounce with 403.
 *
 *   2. The token's `roles[]` claim carries an ACTIVE assignment whose
 *      role name is `super_admin`. Slice 1 ships the `super_admin` gate
 *      hard-wired; granular per-permission gating (`accounting:read` for
 *      ops + finance + auditor; `accounting:adjust` for finance) arrives
 *      once per-resource permissions land on the RBAC catalog (TS-290).
 *      At that point this guard becomes a thin wrapper around
 *      `PermissionGuard` from `@taste-and-see/nest-auth` with the
 *      resource strings instead of the role name.
 *
 * **Why this guard stays local** rather than lifted to
 * `packages/nest-auth`: it binds to accounting-service-specific RBAC
 * semantics. The role name `super_admin` is the Slice-1 wire — future
 * slices swap in `accounting:adjust` / `accounting:read` per-permission
 * gating once TS-290 lands. Until then the per-service guard owns the
 * accounting-domain semantics. (TS-052-followup-11a-5 lifted the shared
 * `AccessTokenGuard` to the package; this guard's `RequestWithContext`
 * type-only import now comes from `@taste-and-see/nest-auth`.)
 */
@Injectable()
export class SuperAdminRoleGuard implements CanActivate {
  private readonly logger = new Logger(SuperAdminRoleGuard.name);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const ctx = request.requestContext;
    if (ctx === undefined) {
      throw new UnauthorizedException(unauthorizedBody());
    }

    const now = new Date();
    if (!holdsAdminRole(ctx.roles, now)) {
      this.logger.warn(
        { actorId: ctx.userId, roleCount: ctx.roles.length },
        'admin endpoint denied: caller holds no admin-staff role',
      );
      throw new ForbiddenException(forbiddenBody());
    }

    for (const role of ctx.roles) {
      if (role.name !== 'super_admin') continue;
      if (!isAssignmentActive(role, now)) continue;
      return true;
    }

    this.logger.warn(
      { actorId: ctx.userId, requiredRole: 'super_admin' },
      'admin endpoint denied: caller holds an admin role but not super_admin',
    );
    throw new ForbiddenException(forbiddenBody());
  }
}

function unauthorizedBody(): {
  readonly type: 'about:blank';
  readonly title: 'Unauthorized';
  readonly status: 401;
  readonly detail: string;
} {
  return {
    type: 'about:blank',
    title: 'Unauthorized',
    status: 401,
    detail: 'Authentication required.',
  };
}

function forbiddenBody(): {
  readonly type: 'about:blank';
  readonly title: 'Forbidden';
  readonly status: 403;
  readonly detail: string;
} {
  return {
    type: 'about:blank',
    title: 'Forbidden',
    status: 403,
    detail: 'Caller lacks the required admin role.',
  };
}
