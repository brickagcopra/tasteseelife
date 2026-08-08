import type { RoleAssignment } from './roles';
import type { TenantScope } from './scope';

/**
 * The per-request authentication / authorisation context (CLAUDE.md §3.2).
 *
 * Constructed at the request boundary (gateway / NestJS guard) from a
 * verified access token, propagated through the request lifecycle, and
 * consulted by every authorisation decision (`hasPermission` /
 * `requirePermission`) and every Prisma tenant-scoping middleware.
 *
 * `tenantScope` is the scope the **request** is acting in — set by upstream
 * routing logic (e.g. when accessing `/households/xyz` it is set to
 * `household:xyz`). Role assignments carry their own scope; the
 * authorisation check intersects the two.
 */
export interface RequestContext {
  readonly userId: string;
  readonly sessionId?: string | undefined;
  readonly mfaVerified: boolean;
  /**
   * When the session is an admin impersonation session (TS-297),
   * the OPERATOR's user id — `userId` is the impersonated user.
   * Undefined on ordinary sessions. Consumers that write audit
   * trails should preserve this alongside the acting user id.
   */
  readonly actorOnBehalfOf?: string | undefined;
  readonly roles: readonly RoleAssignment[];
  readonly tenantScope: TenantScope;
}
