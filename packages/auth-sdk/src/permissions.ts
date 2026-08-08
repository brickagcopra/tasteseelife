import type { RequestContext } from './context';
import { isAssignmentActive } from './roles';
import { formatScope, scopeAllows, type TenantScope } from './scope';

/**
 * Permissions are namespaced strings of the form `resource:action`
 * (CLAUDE.md §2.2 / PDD §10.2). Common examples:
 *
 *   - `subscription:write`
 *   - `provider:approve`
 *   - `accounting:close_period`
 *   - `audit:read`
 *
 * The template-literal type enforces a single colon at type level for
 * obvious typos; runtime validation (e.g. at the role-seeding layer) is the
 * place to enforce the lower-snake-case convention more strictly if needed.
 */
export type PermissionString = `${string}:${string}`;

export interface PermissionCheckOptions {
  /**
   * Override the request scope used for the check. Defaults to the
   * `tenantScope` on the `RequestContext`. Use this when authorising an
   * action against a resource whose effective scope differs from the
   * request's own (e.g. an admin bulk-action across multiple tenants).
   */
  readonly scope?: TenantScope;
  /** Override "now" for deterministic tests. Defaults to `new Date()`. */
  readonly now?: Date;
}

/**
 * Returns `true` iff the user has at least one **active** role assignment
 * whose scope authorises the request scope and whose permissions list
 * includes `permission`.
 *
 * "Active" means: `expiresAt` is `undefined`, or `expiresAt` parses to an
 * instant strictly after `now`. Unparseable `expiresAt` values are treated
 * as expired (fail-closed — a malformed claim must not silently grant).
 *
 * Scope rules: see `scopeAllows` in `./scope.ts`. Flat matching only;
 * hierarchical coverage is the caller's responsibility.
 */
export function hasPermission(
  ctx: RequestContext,
  permission: PermissionString,
  options?: PermissionCheckOptions,
): boolean {
  const now = options?.now ?? new Date();
  const requestScope = options?.scope ?? ctx.tenantScope;

  for (const role of ctx.roles) {
    if (!isAssignmentActive(role, now)) continue;
    if (!scopeAllows(role.scope, requestScope)) continue;
    if (role.permissions.includes(permission)) return true;
  }
  return false;
}

/**
 * Throws `PermissionDeniedError` if `hasPermission` returns false.
 * Intended for use in service-layer guards where a deny path should bubble
 * up to the controller's exception filter (which maps to RFC 7807 — see
 * CLAUDE.md §5.1).
 */
export function requirePermission(
  ctx: RequestContext,
  permission: PermissionString,
  options?: PermissionCheckOptions,
): void {
  if (hasPermission(ctx, permission, options)) return;
  const requestScope = options?.scope ?? ctx.tenantScope;
  throw new PermissionDeniedError({
    permission,
    scope: requestScope,
    userId: ctx.userId,
  });
}

export interface PermissionDeniedDetails {
  readonly permission: PermissionString;
  readonly scope: TenantScope;
  readonly userId: string;
}

export class PermissionDeniedError extends Error {
  public readonly permission: PermissionString;
  public readonly scope: TenantScope;
  public readonly userId: string;

  constructor(details: PermissionDeniedDetails) {
    super(
      `permission denied: ${details.permission} (scope ${formatScope(details.scope)}) for user ${details.userId}`,
    );
    this.name = 'PermissionDeniedError';
    this.permission = details.permission;
    this.scope = details.scope;
    this.userId = details.userId;
  }
}
