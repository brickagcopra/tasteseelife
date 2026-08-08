import type {
  AdminUserActionResponse,
  AdminUserActionStateSnapshot,
  AdminUserDetail,
  AdminUserKycSummary,
  AdminUserLockoutSummary,
  AdminUserMfaSummary,
  AdminUserSummary,
  MeRoleAssignment,
} from '@taste-and-see/contracts';

import type {
  AdminUserActionStateRow,
  AdminUserActionSuccess,
} from '../services/admin-user-actions.service';
import type {
  AdminUserDetailRow,
  AdminUserKycRow,
  AdminUserListRow,
  AdminUserLockout,
  AdminUserMfaRow,
} from '../services/admin-users.service';

/**
 * Project the service-layer row shapes onto the contract DTO shapes.
 *
 * Lives at the controller boundary (TS-126 Slice 1) so the
 * controllers never return raw Prisma rows or service-internal
 * structures (CLAUDE.md §3.3: "All outbound responses pass through
 * DTO mappers — never return raw Prisma objects to the client.").
 *
 * The service-layer types are kept narrow (only the columns the
 * service touches) so any drift between the schema and the contract
 * surfaces here at compile time rather than as a runtime contract
 * violation.
 */
export function summaryRowToDto(row: AdminUserListRow): AdminUserSummary {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    status: row.status,
    mfaEnabled: row.mfaEnabled,
    emailVerifiedAt: row.emailVerifiedAt !== null ? row.emailVerifiedAt.toISOString() : null,
    activeRoleCount: row.activeRoleCount,
    holdsAdminRole: row.holdsAdminRole,
    currentlyLocked: row.currentlyLocked,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function detailRowToDto(row: AdminUserDetailRow): AdminUserDetail {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    status: row.status,
    mfaEnabled: row.mfaEnabled,
    emailVerifiedAt: row.emailVerifiedAt !== null ? row.emailVerifiedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt !== null ? row.deletedAt.toISOString() : null,
    roles: row.roles.map(roleRecordToDto),
    holdsAdminRole: row.holdsAdminRole,
    mfaMethods: row.mfaMethods.map(mfaRowToDto),
    latestKyc: row.latestKyc !== null ? kycRowToDto(row.latestKyc) : null,
    lockout: lockoutToDto(row.lockout),
  };
}

function roleRecordToDto(record: AdminUserDetailRow['roles'][number]): MeRoleAssignment {
  return {
    name: record.name,
    permissions: [...record.permissions],
    scope: record.scope,
    ...(record.expiresAt !== null ? { expiresAt: record.expiresAt.toISOString() } : {}),
  };
}

function mfaRowToDto(row: AdminUserMfaRow): AdminUserMfaSummary {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    confirmedAt: row.confirmedAt.toISOString(),
    lastUsedAt: row.lastUsedAt !== null ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function kycRowToDto(row: AdminUserKycRow): AdminUserKycSummary {
  return {
    id: row.id,
    status: row.status,
    verifiedAt: row.verifiedAt !== null ? row.verifiedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function lockoutToDto(row: AdminUserLockout): AdminUserLockoutSummary {
  return {
    failedLoginCount: row.failedLoginCount,
    lastFailedLoginAt: row.lastFailedLoginAt !== null ? row.lastFailedLoginAt.toISOString() : null,
    lockedUntil: row.lockedUntil !== null ? row.lockedUntil.toISOString() : null,
    currentlyLocked: row.currentlyLocked,
  };
}

/**
 * Project a successful `AdminUserActionResult.value` onto the
 * `AdminUserActionResponse` wire DTO. The controller calls this only
 * when the result is `ok: true`; failure variants short-circuit
 * upstream via typed HttpExceptions (see `mapActionResult`).
 *
 * `now` is taken from the service-stamped `performedAt` so the
 * response carries the exact transition instant (Postgres clock at
 * the write moment). `reason` is null for unlock; `note` is null
 * when the request omitted it.
 */
export function actionResultToDto(input: {
  readonly success: AdminUserActionSuccess;
  readonly action: 'suspend' | 'reinstate' | 'unlock';
  readonly reason: string | null;
  readonly note: string | null;
  readonly performedByUserId: string;
}): AdminUserActionResponse {
  const summary = summaryRowToDto(input.success.user);
  return {
    user: summary,
    action: input.action,
    performedAt: input.success.performedAt.toISOString(),
    performedByUserId: input.performedByUserId,
    before: snapshotToDto(input.success.before, input.success.performedAt),
    after: snapshotToDto(input.success.after, input.success.performedAt),
    // Cast through the contract's narrowed reason union — the
    // controller has already validated the value against the request
    // schema (Zod), and the contract response schema's `parse()` step
    // at the controller boundary re-validates against the narrowed
    // enum, so a drift here surfaces as a parse error rather than a
    // silent shape mismatch. `null` is the unlock-path value.
    reason: input.reason as AdminUserActionResponse['reason'],
    note: input.note,
  };
}

/**
 * Derive the snapshot DTO from a row + reference instant. The
 * reference instant is the service-stamped `performedAt` so the
 * snapshot's `currentlyLocked` flag reflects the moment the action
 * committed (deterministic; not wall-clock-dependent).
 */
function snapshotToDto(
  row: AdminUserActionStateRow,
  performedAt: Date,
): AdminUserActionStateSnapshot {
  return {
    status: row.status,
    failedLoginCount: row.failedLoginCount,
    lastFailedLoginAt: row.lastFailedLoginAt !== null ? row.lastFailedLoginAt.toISOString() : null,
    lockedUntil: row.lockedUntil !== null ? row.lockedUntil.toISOString() : null,
    currentlyLocked: row.lockedUntil !== null && row.lockedUntil.getTime() > performedAt.getTime(),
  };
}
