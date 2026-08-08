import { SetMetadata } from '@nestjs/common';
import type { PermissionString } from '@taste-and-see/auth-sdk';

/**
 * Metadata key under which `@RequirePermissions(...)` stores the
 * required permission list. Read by `PermissionGuard` via
 * `Reflector.getAllAndMerge` so a permission applied at the class
 * level combines with a permission applied at the method level.
 */
export const REQUIRE_PERMISSIONS_METADATA_KEY = 'taste-and-see/require-permissions';

/**
 * Mark a route handler (or controller class) as requiring one or
 * more permissions. The `PermissionGuard` evaluates the merged
 * permission list against the request's `requestContext.roles`
 * (populated upstream by `AccessTokenGuard` or `TrustHeaderGuard`).
 *
 * Permission strings follow the platform-wide `resource:action` shape
 * (CLAUDE.md §2.2). Example:
 *
 *   @RequirePermissions('provider:approve')
 *   @UseGuards(AccessTokenGuard, PermissionGuard)
 *   @Post('admin/providers/:id/tier/evaluate')
 *
 * Semantics:
 *   - Multiple permissions on a single decorator → ALL must be held
 *     (AND).
 *   - Class-level + method-level permissions → both lists are merged
 *     and ALL must be held (still AND).
 *   - Scope is the request's `tenantScope` from `requestContext` by
 *     default; admin tooling can call `requirePermission` directly
 *     with an override scope.
 */
export const RequirePermissions = (
  ...permissions: readonly PermissionString[]
): ClassDecorator & MethodDecorator => SetMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, permissions);
