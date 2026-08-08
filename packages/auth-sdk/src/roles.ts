import type { TenantScope } from './scope';

/**
 * System-defined role names from PDD §10.2.
 *
 * Custom roles (created in the admin RBAC tooling) are also `string`-typed,
 * so `RoleAssignment.name` is `string` rather than `SystemRoleName`.
 * This constant union exists for type-narrowing in places that explicitly
 * reason about system roles (e.g. enforcing that `super_admin` always has
 * `global` scope, or that `finance:adjust` is gated to `finance` /
 * `super_admin`).
 */
export const SYSTEM_ROLE_NAMES = [
  // Customer-facing
  'family_payer',
  'family_observer',
  'senior_user',
  'provider',
  'partner_admin',
  'partner_member',
  'student',
  // Admin staff (PDD §10.2)
  'super_admin',
  'operations_manager',
  'customer_support',
  'concierge_lead',
  'provider_ops',
  'finance',
  'marketing',
  'content_editor',
  'trust_safety',
  'read_only_auditor',
] as const;

export type SystemRoleName = (typeof SYSTEM_ROLE_NAMES)[number];

/**
 * Admin-staff roles per PDD §10.2. Holding any of these triggers the
 * "MFA mandatory for staff" rule (CLAUDE.md §3.1) — the identity
 * service refuses to issue a session for an admin-role-holder whose
 * `users.mfa_enabled` is false.
 *
 * Source of truth lives here (not in the seed catalog) because every
 * verifier — gateway-api, downstream services, the future admin
 * tooling — needs to make the same admin/non-admin determination
 * against a token's `roles[]` claim. Centralising the list prevents
 * drift between issuer and verifier.
 */
export const ADMIN_ROLE_NAMES = [
  'super_admin',
  'operations_manager',
  'customer_support',
  'concierge_lead',
  'provider_ops',
  'finance',
  'marketing',
  'content_editor',
  'trust_safety',
  'read_only_auditor',
] as const satisfies ReadonlyArray<SystemRoleName>;

export type AdminRoleName = (typeof ADMIN_ROLE_NAMES)[number];

const ADMIN_ROLE_LOOKUP: Readonly<Record<string, true>> = Object.fromEntries(
  ADMIN_ROLE_NAMES.map((n) => [n, true]),
);

/**
 * `true` if `name` matches one of the admin-staff roles in
 * `ADMIN_ROLE_NAMES`. Custom roles created in the admin RBAC tooling
 * are deliberately NOT considered admin here — the MFA-mandatory rule
 * applies to the system-defined staff roles (PDD §10.2). Custom roles
 * with elevated permissions should be configured to require MFA via
 * a separate per-permission policy when that surface lands (TS-290).
 */
export function isAdminRoleName(name: string): name is AdminRoleName {
  return ADMIN_ROLE_LOOKUP[name] === true;
}

/**
 * `true` if any active assignment in `roles` is an admin-staff role.
 * Active means: not expired (per `isAssignmentActive`) AND its name is
 * in `ADMIN_ROLE_NAMES`.
 *
 * Used by:
 *   - `service-identity`: the login-time MFA gate (this file's
 *     companion `RoleAssignmentService.holdsAnyRole(userId, ADMIN_ROLE_NAMES)`
 *     is the equivalent server-side query for users whose tokens have
 *     not yet been minted).
 *   - Future verifiers (gateway-api, downstream services) that need
 *     to enforce per-request "this caller is staff" checks against an
 *     access token's `roles` claim.
 */
export function holdsAdminRole(roles: readonly RoleAssignment[], now: Date = new Date()): boolean {
  for (const role of roles) {
    if (!isAssignmentActive(role, now)) continue;
    if (isAdminRoleName(role.name)) return true;
  }
  return false;
}

/**
 * A role assignment as carried on an access token claim.
 *
 * Permissions are denormalised onto the assignment at token-issue time so
 * the auth-sdk can authorise without a network round trip. The trade-off is
 * a longer JWT in exchange for stateless verification — acceptable at our
 * scale (tens of role-permission entries per user, max).
 *
 * `expiresAt` is optional ISO-8601; when present, the assignment is treated
 * as inactive at and after that instant (PDD §10.2 — role assignments
 * support expiration; CLAUDE.md §3.2).
 */
export interface RoleAssignment {
  readonly name: string;
  readonly scope: TenantScope;
  readonly permissions: readonly string[];
  readonly expiresAt?: string | undefined;
}

export function isAssignmentActive(role: RoleAssignment, now: Date): boolean {
  if (role.expiresAt === undefined) return true;
  const exp = Date.parse(role.expiresAt);
  if (Number.isNaN(exp)) return false;
  return exp > now.getTime();
}
