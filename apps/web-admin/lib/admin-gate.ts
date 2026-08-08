import {
  ADMIN_ROLE_NAMES,
  isAdminRoleName,
  isAssignmentActive,
  type AdminRoleName,
  type RoleAssignment,
} from '@taste-and-see/auth-sdk';
import type { MeResponse } from '@taste-and-see/contracts';

/**
 * Admin gate helpers (TS-123).
 *
 * Pure functions that inspect a `MeResponse` (returned by the gateway's
 * `GET /api/v1/me` actor-identity readback) and decide:
 *
 *   1. `hasAnyAdminRole` — does the actor hold ANY active admin-staff
 *      role (per `ADMIN_ROLE_NAMES` in auth-sdk)? Used at the
 *      protected-layout gate: an authenticated user with no admin role
 *      is bounced back to `/login?no_admin_role=1` rather than ever
 *      reaching the admin console UI. The gateway's MFA-required
 *      enforcement in service-identity (TS-023-followup-1) means an
 *      admin-role-holder cannot reach this point without `mfaVerified`
 *      already true on the token, but we check it here anyway for
 *      defence-in-depth.
 *
 *   2. `hasSuperAdminRole` — does the actor hold the `super_admin`
 *      role specifically? Phase-1 only admits super_admins to the
 *      console root surface. Other admin roles (operations_manager,
 *      finance, etc.) authenticate successfully but land on a
 *      "permissions pending" placeholder until the per-surface
 *      RBAC gating lands with TS-126 / TS-290.
 *
 *   3. `hasRoleName` — generic helper for surfaces that gate on a
 *      specific role (e.g. finance role on the accounting view, once
 *      TS-129 lands).
 *
 * All helpers re-use auth-sdk's `isAssignmentActive` so an expired
 * assignment (CLAUDE.md §3.2 — "Role assignments support expiration")
 * is treated as if the role isn't held. The MeResponse's role-assignment
 * shape is a superset of auth-sdk's `RoleAssignment`; the conversion
 * is structural and zero-cost.
 */

function toRoleAssignment(meRole: MeResponse['roles'][number]): RoleAssignment {
  return {
    name: meRole.name,
    permissions: meRole.permissions,
    scope: meRole.scope,
    ...(meRole.expiresAt !== undefined && { expiresAt: meRole.expiresAt }),
  };
}

/**
 * `true` if `me` carries at least one active assignment whose role name
 * is in `ADMIN_ROLE_NAMES`. Custom roles are deliberately NOT considered
 * admin here — the gate applies to the PDD §10.2 system-defined staff
 * roles. Custom-role-based admin surfaces will hang off TS-290.
 */
export function hasAnyAdminRole(me: MeResponse, now: Date = new Date()): boolean {
  for (const role of me.roles) {
    if (!isAssignmentActive(toRoleAssignment(role), now)) continue;
    if (isAdminRoleName(role.name)) return true;
  }
  return false;
}

/**
 * `true` if `me` carries an active `super_admin` assignment. Phase-1
 * landing gate for the admin console root surface.
 */
export function hasSuperAdminRole(me: MeResponse, now: Date = new Date()): boolean {
  return hasRoleName(me, 'super_admin', now);
}

/**
 * `true` if `me` carries an active assignment with the given role name.
 * Caller picks any name (system or custom); the helper just checks
 * presence + expiry.
 */
export function hasRoleName(me: MeResponse, name: string, now: Date = new Date()): boolean {
  for (const role of me.roles) {
    if (role.name !== name) continue;
    if (!isAssignmentActive(toRoleAssignment(role), now)) continue;
    return true;
  }
  return false;
}

/**
 * `true` if `me` holds an active role assignment whose denormalised
 * permission set includes `permission` (a `resource:action` string). Mirrors
 * auth-sdk's server-side `hasPermission` flat check — admin roles are
 * global-scoped, so this is a presence check across active assignments. The
 * authoritative enforcement is server-side (`PermissionGuard`); this gate
 * decides which admin surfaces the console renders for the operator.
 *
 * Used by the concierge ops console (TS-224) — gated on `concierge:read`.
 */
export function hasPermission(me: MeResponse, permission: string, now: Date = new Date()): boolean {
  for (const role of me.roles) {
    if (!isAssignmentActive(toRoleAssignment(role), now)) continue;
    if (role.permissions.includes(permission)) return true;
  }
  return false;
}

/**
 * List of admin role names the actor currently holds (active only).
 * Useful for the "permissions pending" placeholder so the operator
 * can see exactly which role is granted and which permissions it
 * will eventually unlock.
 */
export function activeAdminRoleNames(
  me: MeResponse,
  now: Date = new Date(),
): readonly AdminRoleName[] {
  const out: AdminRoleName[] = [];
  for (const role of me.roles) {
    if (!isAssignmentActive(toRoleAssignment(role), now)) continue;
    if (isAdminRoleName(role.name)) out.push(role.name);
  }
  return out;
}

/**
 * Re-export the admin-role catalog so dashboard placeholders can list
 * the eligible roles without re-importing auth-sdk in every component.
 */
export { ADMIN_ROLE_NAMES };
