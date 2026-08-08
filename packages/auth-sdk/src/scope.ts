/**
 * Authorization scope (PDD §10.2).
 *
 * Roles attach to one of three scope levels:
 *   - `global` — covers every request (super-admin, finance, content editors).
 *   - `tenant` — covers requests acting on behalf of a partner organisation.
 *   - `household` — covers requests acting on behalf of a single senior household.
 *
 * Scope matching in this SDK is **flat**: a `tenant:abc` role does NOT
 * implicitly grant access to a `household:xyz` request even if `xyz` belongs
 * to `abc`. The mapping "household belongs to tenant" lives in `partner-svc`
 * and is enforced by the calling service when it builds the request scope —
 * the gateway/middleware sets the broadest matching scope on the request
 * before calling `hasPermission`. Keeping the SDK flat avoids embedding a
 * partner-data dependency at the auth layer.
 */
export type TenantScope =
  | { readonly type: 'global' }
  | { readonly type: 'tenant'; readonly tenantId: string }
  | { readonly type: 'household'; readonly householdId: string };

export const GLOBAL_SCOPE: TenantScope = { type: 'global' };

/**
 * `roleScope` (the scope the role assignment is attached to) authorises
 * `requestScope` (the scope the request is acting in) when:
 *   - the role is `global`, or
 *   - the role and request scopes are the same type *and* the same id.
 *
 * Anything else returns `false`. Callers that want hierarchical coverage
 * (e.g. tenant-admin acting on a household within their tenant) must
 * normalise the request's scope to the broadest matching role-eligible
 * scope before calling.
 */
export function scopeAllows(roleScope: TenantScope, requestScope: TenantScope): boolean {
  if (roleScope.type === 'global') return true;
  if (roleScope.type === 'tenant' && requestScope.type === 'tenant') {
    return roleScope.tenantId === requestScope.tenantId;
  }
  if (roleScope.type === 'household' && requestScope.type === 'household') {
    return roleScope.householdId === requestScope.householdId;
  }
  return false;
}

export function formatScope(scope: TenantScope): string {
  switch (scope.type) {
    case 'global':
      return 'global';
    case 'tenant':
      return `tenant:${scope.tenantId}`;
    case 'household':
      return `household:${scope.householdId}`;
  }
}
