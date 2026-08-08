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
 * Phase-1 admin gate (TS-126 Slice 1).
 *
 * Run AFTER `AccessTokenGuard` — relies on `request.requestContext`
 * being populated. Enforces two policies in order:
 *
 *   1. The token's `roles[]` claim carries at least one active admin-
 *      staff role (per `auth-sdk`'s `ADMIN_ROLE_NAMES`). Otherwise the
 *      caller is authenticated but not staff — bounce with 403.
 *
 *   2. The token's `roles[]` claim carries an ACTIVE assignment whose
 *      role name matches one of `requiredRoles`. Slice 1 ships the
 *      `super_admin` gate hard-wired; granular per-permission gating
 *      arrives once `PermissionGuard` lifts to `packages/nest-auth`
 *      (TS-052-followup-11) and per-resource permissions land on the
 *      RBAC catalog (TS-290).
 *
 * **Why a separate guard from `AccessTokenGuard`.** `AccessTokenGuard`
 * answers "is this a verified user?" The admin gate answers "is this
 * verified user a member of staff with the right authority?" Keeping
 * them separate means a non-admin call short-circuits at the first
 * guard with a 401 (forgery) vs the second with a 403 (privilege),
 * which preserves the standard auth/authz error semantics.
 *
 * **Forward compatibility.** The factory function lets callers
 * specify which role names to require — Slice 1 uses `super_admin`
 * exclusively because Phase-1 only super_admins are exempt from the
 * "permissions pending" gate, but future surfaces (TS-127, TS-128,
 * TS-129) will require other admin roles. When `PermissionGuard`
 * lifts, this guard becomes a thin wrapper around it.
 */
@Injectable()
export class SuperAdminRoleGuard implements CanActivate {
  private readonly logger = new Logger(SuperAdminRoleGuard.name);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const ctx = request.requestContext;
    if (ctx === undefined) {
      // Defence in depth: the upstream `AccessTokenGuard` should have
      // attached the context. If it didn't (misconfiguration), refuse
      // rather than treat the call as anonymous.
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
