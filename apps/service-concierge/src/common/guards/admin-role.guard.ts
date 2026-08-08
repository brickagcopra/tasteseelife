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
 * Phase-1 admin gate (TS-222) — port of service-subscription's
 * `SuperAdminRoleGuard`. Run AFTER `AccessTokenGuard` — relies on
 * `request.requestContext` being populated.
 *
 * Enforces two policies in order:
 *
 *   1. The token's `roles[]` claim carries at least one active admin-
 *      staff role (per `auth-sdk`'s `ADMIN_ROLE_NAMES`). Otherwise the
 *      caller is authenticated but not staff — bounce with 403.
 *
 *   2. The token's `roles[]` claim carries an ACTIVE `super_admin`
 *      assignment. Slice ships the `super_admin` gate hard-wired;
 *      granular per-permission gating (`concierge:write` for
 *      concierge_lead + operations_manager) arrives once `PermissionGuard`
 *      lifts to `packages/nest-auth` (TS-052-followup-11) and the
 *      per-resource permissions land on the RBAC catalog (TS-290). At
 *      that point this guard becomes a thin wrapper around the lifted
 *      permission guard with `concierge:write` instead of the role name.
 *
 * **Why a separate guard from `AccessTokenGuard`.** `AccessTokenGuard`
 * answers "is this a verified user?" — this guard answers "is this
 * verified user a member of staff with the right authority?". Keeping
 * them separate preserves the 401 (forgery) vs 403 (privilege) split.
 */
@Injectable()
export class SuperAdminRoleGuard implements CanActivate {
  private readonly logger = new Logger(SuperAdminRoleGuard.name);

  canActivate(context: ExecutionContext): boolean {
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
