import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import { RoleAssignmentService } from '../../rbac/role-assignment.service';

/**
 * Local enum mirrors. Same TS-021-followup-2 / -3 / TS-026-followup-5
 * root cause — Prisma 5.22's namespace value-side resolves
 * inconsistently under our tsconfig, so services use locally-declared
 * string-literal unions for the generated enums. The cross-pin is the
 * contract-side `UserStatusSchema` enum + the existing AuthService /
 * KycService mirrors; drift surfaces at the first call that passes a
 * non-listed string to Prisma.
 */
type UserStatusValue = 'pending_verification' | 'active' | 'suspended' | 'deactivated';

type MfaMethodKindValue = 'totp' | 'sms_backup';

type KycRecordStatusValue =
  | 'pending'
  | 'processing'
  | 'verified'
  | 'requires_input'
  | 'failed'
  | 'canceled';

/**
 * Page entry returned by `list()`. The "active role count" and
 * "holds admin role" flags are denormalised at query time so the
 * list page can render without an N+1 detail fetch — the per-user
 * role-assignment fetch is bounded by `findUserRoleSummaries`
 * (one Prisma call across the entire page, joined on user_id).
 */
export interface AdminUserListRow {
  readonly id: string;
  readonly email: string;
  readonly phone: string | null;
  readonly status: UserStatusValue;
  readonly mfaEnabled: boolean;
  readonly emailVerifiedAt: Date | null;
  readonly activeRoleCount: number;
  readonly holdsAdminRole: boolean;
  readonly currentlyLocked: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminUserListPage {
  readonly users: readonly AdminUserListRow[];
  readonly nextCursor: string | null;
}

export interface AdminUserMfaRow {
  readonly id: string;
  readonly kind: MfaMethodKindValue;
  readonly label: string | null;
  readonly confirmedAt: Date;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
}

export interface AdminUserKycRow {
  readonly id: string;
  readonly status: KycRecordStatusValue;
  readonly verifiedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminUserLockout {
  readonly failedLoginCount: number;
  readonly lastFailedLoginAt: Date | null;
  readonly lockedUntil: Date | null;
  readonly currentlyLocked: boolean;
}

export interface AdminUserDetailRow {
  readonly id: string;
  readonly email: string;
  readonly phone: string | null;
  readonly status: UserStatusValue;
  readonly mfaEnabled: boolean;
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  /**
   * Active role assignments only (revokedAt null AND not expired).
   * The detail view does not surface revoked / expired assignments
   * in Slice 1; full history arrives with TS-290.
   */
  readonly roles: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly permissions: readonly string[];
    readonly scope:
      | { readonly type: 'global' }
      | { readonly type: 'tenant'; readonly tenantId: string }
      | { readonly type: 'household'; readonly householdId: string };
    readonly expiresAt: Date | null;
  }>;
  readonly holdsAdminRole: boolean;
  readonly mfaMethods: readonly AdminUserMfaRow[];
  readonly latestKyc: AdminUserKycRow | null;
  readonly lockout: AdminUserLockout;
}

export interface ListUsersInput {
  readonly q?: string | undefined;
  readonly status?: UserStatusValue | undefined;
  readonly roleName?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly now?: Date | undefined;
}

export interface GetUserByIdInput {
  readonly userId: string;
  readonly now?: Date | undefined;
}

/**
 * Admin users management service (TS-126 Slice 1).
 *
 * Owns the read-only `GET /api/v1/admin/users` and
 * `GET /api/v1/admin/users/:id` surfaces. Both endpoints are gated
 * upstream by `AccessTokenGuard` + `SuperAdminRoleGuard`; this service
 * does NOT re-check authorisation — it trusts the controller layer to
 * have done so.
 *
 * **Cursor pagination.** Opaque base64-encoded `{createdAt-ISO, id}`
 * pair. Server-side fixed ordering: `createdAt DESC, id DESC` (newest
 * first). Stable secondary sort on `id` so equal-`createdAt` rows
 * page deterministically. Soft-deleted users (`deletedAt != null`)
 * are EXCLUDED by default; admin-tooling that needs to inspect
 * deleted accounts is a future follow-up.
 *
 * **Search shape.** Case-insensitive substring on `email` (Prisma's
 * `contains` + `mode: 'insensitive'`). Status filter is exact-match.
 * Role filter joins through `user_roles` via the User → UserRole
 * back-reference (TS-126-followup-6) — `where: { roles: { some: {
 * revokedAt: null, OR: [...], role: { name } } } }` — collapsed
 * from the previous two-step "resolve userIds, narrow by id IN"
 * pattern into one Prisma round-trip.
 *
 * **Denormalisation.** The list response carries `activeRoleCount`
 * and `holdsAdminRole` per user so the list page renders without
 * an N+1 detail fetch. These are computed by a single
 * `userRole.findMany` call across all page users (one Prisma round-
 * trip), aggregated in-process.
 */
@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly roleAssignments: RoleAssignmentService,
  ) {}

  async list(input: ListUsersInput): Promise<AdminUserListPage> {
    const now = input.now ?? new Date();
    const limit = clampLimit(input.limit);

    // Decode cursor first so a malformed cursor surfaces as a
    // documented behaviour (treated as "start from the top") rather
    // than a 500. Future follow-up: opt-in 400 on bad cursor for
    // admin tooling where the wrong cursor IS the bug.
    const decoded = decodeCursor(input.cursor);
    const q = input.q?.trim();

    const where = {
      deletedAt: null,
      ...(q !== undefined && q.length > 0
        ? { email: { contains: q, mode: 'insensitive' as const } }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      // TS-126-followup-6: collapse the previous two-step "fetch
      // matching userIds, then narrow with id: { in: ... }" pattern
      // into a single Prisma `roles: { some: ... }` semi-join.
      // Powered by the User → UserRole back-reference declared in
      // schema.prisma (the FK constraint landed in
      // `20260520120000_add_user_userrole_relation_fk`). Zero query
      // overhead when role filtering is not requested — Prisma
      // generates no extra SQL for an unused relation predicate.
      ...(input.roleName !== undefined
        ? {
            roles: {
              some: {
                revokedAt: null,
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                role: { name: input.roleName },
              },
            },
          }
        : {}),
      ...(decoded !== null
        ? {
            // Keyset pagination: `(createdAt, id)` strictly LESS than
            // the cursor's `(createdAt, id)` under DESC ordering.
            // Modelled as the disjunction (createdAt < c) OR
            // (createdAt = c AND id < c.id) so equal-timestamp rows
            // page in id-DESC order.
            OR: [
              { createdAt: { lt: decoded.createdAt } },
              {
                AND: [{ createdAt: decoded.createdAt }, { id: { lt: decoded.id } }],
              },
            ],
          }
        : {}),
    };

    // Fetch limit+1 so we can decide whether to emit a cursor.
    // Explicit row shape — the conditional `where` spread defeats
    // Prisma's inferred return type, so we pin the select shape here
    // and let the local annotation flow through `trimmed.map`.
    type UserListPrismaRow = {
      readonly id: string;
      readonly email: string;
      readonly phone: string | null;
      readonly status: UserStatusValue;
      readonly mfaEnabled: boolean;
      readonly emailVerifiedAt: Date | null;
      readonly failedLoginCount: number;
      readonly lockedUntil: Date | null;
      readonly createdAt: Date;
      readonly updatedAt: Date;
    };

    const rows: UserListPrismaRow[] = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        phone: true,
        status: true,
        mfaEnabled: true,
        emailVerifiedAt: true,
        failedLoginCount: true,
        lockedUntil: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const trimmed = rows.slice(0, limit);
    const last = trimmed.at(-1);
    const hasMore = rows.length > limit;
    const nextCursor = hasMore && last !== undefined ? encodeCursor(last.createdAt, last.id) : null;

    // Bulk fetch role summaries for the page's user ids in one round-trip.
    const userIds = trimmed.map((r) => r.id);
    const summaries = await this.findUserRoleSummaries(userIds, now);

    const users: AdminUserListRow[] = trimmed.map((row): AdminUserListRow => {
      const summary = summaries.get(row.id) ?? { activeRoleCount: 0, holdsAdminRole: false };
      return {
        id: row.id,
        email: row.email,
        phone: row.phone,
        status: row.status as UserStatusValue,
        mfaEnabled: row.mfaEnabled,
        emailVerifiedAt: row.emailVerifiedAt,
        activeRoleCount: summary.activeRoleCount,
        holdsAdminRole: summary.holdsAdminRole,
        currentlyLocked: isCurrentlyLocked(row.lockedUntil, now),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });

    this.logger.log(
      {
        actorId: '<admin>',
        resultCount: users.length,
        hasMore,
        filters: {
          q: q !== undefined && q.length > 0,
          status: input.status ?? null,
          roleName: input.roleName ?? null,
        },
      },
      'admin.users.list',
    );

    return { users, nextCursor };
  }

  async getById(input: GetUserByIdInput): Promise<AdminUserDetailRow | null> {
    const now = input.now ?? new Date();

    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        email: true,
        phone: true,
        status: true,
        mfaEnabled: true,
        emailVerifiedAt: true,
        failedLoginCount: true,
        lastFailedLoginAt: true,
        lockedUntil: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
    });
    if (user === null) return null;

    // Explicit row shapes for the parallel reads — Promise.all + the
    // narrowed Prisma select shape don't always survive inference,
    // particularly under `noUncheckedIndexedAccess`.
    type MfaPrismaRow = {
      readonly id: string;
      readonly kind: MfaMethodKindValue;
      readonly label: string | null;
      readonly confirmedAt: Date | null;
      readonly lastUsedAt: Date | null;
      readonly createdAt: Date;
    };
    type KycPrismaRow = {
      readonly id: string;
      readonly status: KycRecordStatusValue;
      readonly verifiedAt: Date | null;
      readonly createdAt: Date;
      readonly updatedAt: Date;
    };

    const [roleRecords, mfaRows, latestKyc]: [
      Awaited<ReturnType<typeof this.roleAssignments.listForUser>>,
      MfaPrismaRow[],
      KycPrismaRow | null,
    ] = await Promise.all([
      this.roleAssignments.listForUser(user.id, { now, includeInactive: false }),
      this.prisma.mfaMethod.findMany({
        where: { userId: user.id, confirmedAt: { not: null }, deletedAt: null },
        select: {
          id: true,
          kind: true,
          label: true,
          confirmedAt: true,
          lastUsedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }) as Promise<MfaPrismaRow[]>,
      this.prisma.kycRecord.findFirst({
        where: { userId: user.id },
        select: {
          id: true,
          status: true,
          verifiedAt: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }) as Promise<KycPrismaRow | null>,
    ]);

    const roles: AdminUserDetailRow['roles'] = roleRecords.map((r) => ({
      id: r.id,
      name: r.assignment.name,
      permissions: r.assignment.permissions,
      scope: r.assignment.scope,
      expiresAt: r.assignment.expiresAt !== undefined ? new Date(r.assignment.expiresAt) : null,
    }));

    const mfaMethods: AdminUserMfaRow[] = mfaRows
      .filter((m): m is MfaPrismaRow & { confirmedAt: Date } => m.confirmedAt !== null)
      .map(
        (m): AdminUserMfaRow => ({
          id: m.id,
          kind: m.kind,
          label: m.label,
          confirmedAt: m.confirmedAt,
          lastUsedAt: m.lastUsedAt,
          createdAt: m.createdAt,
        }),
      );

    const kyc: AdminUserKycRow | null =
      latestKyc !== null
        ? {
            id: latestKyc.id,
            status: latestKyc.status as KycRecordStatusValue,
            verifiedAt: latestKyc.verifiedAt,
            createdAt: latestKyc.createdAt,
            updatedAt: latestKyc.updatedAt,
          }
        : null;

    const lockout: AdminUserLockout = {
      failedLoginCount: user.failedLoginCount,
      lastFailedLoginAt: user.lastFailedLoginAt,
      lockedUntil: user.lockedUntil,
      currentlyLocked: isCurrentlyLocked(user.lockedUntil, now),
    };

    const holdsAdmin = computeHoldsAdminRole(roles, now);

    this.logger.log({ actorId: '<admin>', targetUserId: user.id }, 'admin.users.detail');

    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      status: user.status as UserStatusValue,
      mfaEnabled: user.mfaEnabled,
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      deletedAt: user.deletedAt,
      roles,
      holdsAdminRole: holdsAdmin,
      mfaMethods,
      latestKyc: kyc,
      lockout,
    };
  }

  /**
   * Bulk-fetch role summaries for a list of user ids. Returns a Map
   * keyed by userId with the activeRoleCount + holdsAdminRole flags.
   * One Prisma call across all ids.
   */
  private async findUserRoleSummaries(
    userIds: readonly string[],
    now: Date,
  ): Promise<Map<string, { activeRoleCount: number; holdsAdminRole: boolean }>> {
    const out = new Map<string, { activeRoleCount: number; holdsAdminRole: boolean }>();
    if (userIds.length === 0) return out;

    const rows = await this.prisma.userRole.findMany({
      where: {
        userId: { in: [...userIds] },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: {
        userId: true,
        role: { select: { name: true } },
      },
    });

    for (const row of rows) {
      const current = out.get(row.userId) ?? { activeRoleCount: 0, holdsAdminRole: false };
      const isAdmin = ADMIN_ROLE_LOOKUP.has(row.role.name);
      out.set(row.userId, {
        activeRoleCount: current.activeRoleCount + 1,
        holdsAdminRole: current.holdsAdminRole || isAdmin,
      });
    }
    return out;
  }
}

/**
 * Lookup for the admin-role check in the list summary fetch. Kept in
 * lockstep with `ADMIN_ROLE_NAMES` from auth-sdk; duplicated here as
 * a Set so the per-row check is O(1) without a function-call frame.
 */
const ADMIN_ROLE_LOOKUP: ReadonlySet<string> = new Set([
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
]);

function clampLimit(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return 25;
  if (requested > 100) return 100;
  return Math.floor(requested);
}

function isCurrentlyLocked(lockedUntil: Date | null, now: Date): boolean {
  if (lockedUntil === null) return false;
  return lockedUntil.getTime() > now.getTime();
}

function computeHoldsAdminRole(
  roles: ReadonlyArray<{ name: string; expiresAt: Date | null }>,
  now: Date,
): boolean {
  for (const r of roles) {
    if (!ADMIN_ROLE_LOOKUP.has(r.name)) continue;
    if (r.expiresAt !== null && r.expiresAt.getTime() <= now.getTime()) continue;
    return true;
  }
  return false;
}

/**
 * Cursor codec: base64url of `${createdAtIso}|${id}`. The pipe is
 * legal in id strings only theoretically (cuid2 / uuid use `[a-z0-9-]`
 * only), but the parser splits on the FIRST pipe to be robust against
 * future id formats that might.
 */
export function encodeCursor(createdAt: Date, id: string): string {
  const payload = `${createdAt.toISOString()}|${id}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): { createdAt: Date; id: string } | null {
  if (raw === undefined) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const pipe = decoded.indexOf('|');
    if (pipe < 0) return null;
    const iso = decoded.slice(0, pipe);
    const id = decoded.slice(pipe + 1);
    if (id.length === 0) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
