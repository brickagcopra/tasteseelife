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
 * Edge-level admin gate (TS-126 Slice 1).
 *
 * Mirrors the `SuperAdminRoleGuard` in `service-identity` so the
 * gateway short-circuits any admin call from a non-staff caller
 * BEFORE the downstream service-identity is touched. The downstream
 * service-identity guard remains in place as defence-in-depth for
 * any caller that bypasses the gateway (TS-151 NetworkPolicy will
 * eventually cordon direct cluster reachability of those routes; until
 * then the in-cluster gate is required).
 *
 * Runs AFTER `AccessTokenGuard` — relies on `request.requestContext`
 * being populated. Enforces two policies in order:
 *
 *   1. The token's `roles[]` claim carries at least one active admin-
 *      staff role (per `auth-sdk`'s `ADMIN_ROLE_NAMES`). Otherwise
 *      the caller is authenticated but not staff — bounce with 403.
 *
 *   2. The token's `roles[]` claim carries an ACTIVE `super_admin`
 *      assignment. Slice 1 hard-wires the gate to `super_admin`
 *      because Phase-1 only super_admins reach the admin surface
 *      (per the existing `lib/admin-gate.ts` policy in web-admin).
 *      Other admin roles (operations_manager, finance, etc.) land
 *      on the "permissions pending" placeholder.
 *
 * When `PermissionGuard` lifts to `packages/nest-auth`
 * (TS-052-followup-11) this guard becomes a thin wrapper around the
 * per-permission gate.
 */
@Injectable()
export class SuperAdminRoleGuard implements CanActivate {
  private readonly logger = new Logger(SuperAdminRoleGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const ctx = request.requestContext;
    if (ctx === undefined) {
      // Defence in depth: the upstream `AccessTokenGuard` should have
      // attached the context. If it didn't, refuse rather than treat
      // the call as anonymous.
      throw new UnauthorizedException(unauthorizedBody());
    }

    const now = new Date();
    if (!holdsAdminRole(ctx.roles, now)) {
      this.logger.warn(
        { actorId: ctx.userId, roleCount: ctx.roles.length },
        'gateway admin endpoint denied: caller holds no admin-staff role',
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
      'gateway admin endpoint denied: caller holds an admin role but not super_admin',
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
