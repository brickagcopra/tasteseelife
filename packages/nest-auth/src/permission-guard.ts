import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasPermission, type PermissionString, type RequestContext } from '@taste-and-see/auth-sdk';
import type { Request } from 'express';

import { REQUIRE_PERMISSIONS_METADATA_KEY } from './require-permissions.decorator';

/**
 * Express request shape with the optional `requestContext` slot the
 * upstream `AccessTokenGuard` (or `TrustHeaderGuard`) populates.
 * Mirrored locally so the guard doesn't reach into another file
 * directly for the type.
 */
interface RequestWithContext extends Request {
  requestContext?: RequestContext;
}

/**
 * RBAC permission guard. Reads the merged permission list set by
 * `@RequirePermissions(...)` (class-level + method-level) and
 * evaluates it against the request's `requestContext.roles`.
 *
 * **Ordering.** `PermissionGuard` MUST run *after* a guard that
 * populates `request.requestContext` (e.g. `AccessTokenGuard` from
 * this package, or `TrustHeaderGuard` from `@taste-and-see/nest-
 * internal-trust`). Apply them in order on the controller:
 *
 *   @UseGuards(AccessTokenGuard, PermissionGuard)
 *
 * **Failure modes**:
 *   - No `@RequirePermissions(...)` metadata → no check (handler is
 *     responsible for explicit checks if it needs them). The guard
 *     is a no-op so a controller that wires it without metadata
 *     stays callable.
 *   - Metadata present but `requestContext` absent → 401. Should not
 *     happen if `AccessTokenGuard` ran first; surfacing the 401
 *     makes the misconfiguration loud.
 *   - Metadata present + context present + permission missing → 403
 *     with an RFC 7807 body listing the required permission. (The
 *     exception filter wraps it.)
 *
 * **Scope semantics**. Today the guard evaluates against the request's
 * `tenantScope` (set by the access-token verification). When TS-141
 * lands its Prisma tenant-scoping extension, the guard stays
 * unchanged — the row-level filter pushes orthogonally.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndMerge<readonly PermissionString[]>(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const ctx = request.requestContext;
    if (ctx === undefined) {
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication required.',
      });
    }

    for (const permission of required) {
      if (!hasPermission(ctx, permission)) {
        throw new ForbiddenException({
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: `Missing required permission: ${permission}.`,
        });
      }
    }

    return true;
  }
}
