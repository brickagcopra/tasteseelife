import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { RoleAssignment, TenantScope } from '@taste-and-see/auth-sdk';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * Duck-typed narrowing for Prisma's `KnownRequestError` — same
 * rationale as the sibling guard in `auth.service.ts` (the generated
 * `Prisma.PrismaClientKnownRequestError` namespace type is fragile
 * under this tsconfig's strictness permutations; we only read
 * `.code`). P2002 = unique constraint violation.
 */
interface PrismaKnownRequestError {
  readonly code: string;
  readonly meta?: { readonly target?: readonly string[] };
}

function isPrismaKnownRequestError(err: unknown): err is PrismaKnownRequestError {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string';
}

/**
 * Database-side scope type as stored in `identity.user_roles.scope_type`.
 * Mirrors the Postgres enum from the TS-024 migration; kept narrow so
 * the conversion to/from auth-sdk's `TenantScope` is a single place.
 */
type DbScopeType = 'global' | 'tenant' | 'household';

/**
 * The write surface `grant` / `revoke` touch — a narrow structural
 * client (repo idiom) satisfied by BOTH `PrismaService` and an
 * interactive-transaction client. Callers that need the write to
 * commit atomically with collateral rows (the TS-295 audit event)
 * pass their `$transaction` client; everyone else omits it and the
 * service writes through `this.prisma` as before.
 */
export interface RoleAssignmentWriteClient {
  readonly role: {
    findUnique(req: {
      where: { name: string };
      select: { id: true; name: true; archivedAt: true };
    }): Promise<{ id: string; name: string; archivedAt: Date | null } | null>;
  };
  readonly userRole: {
    create(req: {
      data: {
        userId: string;
        roleId: string;
        scopeType: DbScopeType;
        scopeId: string | null;
        grantedByUserId: string | null;
        expiresAt: Date | null;
      };
      select: { id: true };
    }): Promise<{ id: string }>;
    updateMany(req: {
      where: { id: string; revokedAt: null };
      data: { revokedAt: Date };
    }): Promise<{ count: number }>;
  };
}

/**
 * Shape of a role-assignment row returned by `listForUser`. Keeps the
 * auth-sdk's denormalised shape but adds the database id so admin
 * tooling can revoke a specific assignment.
 */
export interface RoleAssignmentRecord {
  readonly id: string;
  readonly userId: string;
  readonly assignment: RoleAssignment;
  readonly active: boolean;
  readonly grantedByUserId: string | null;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

export interface GrantRoleInput {
  readonly userId: string;
  readonly roleName: string;
  readonly scope: TenantScope;
  /**
   * Admin user id that issued the grant. Optional because system
   * grants (e.g. signup flow assigning `family_payer`) have no
   * authenticated actor — the audit trail records the granting flow
   * in those cases.
   */
  readonly grantedByUserId?: string | undefined;
  /**
   * Optional UTC absolute-time expiration. CLAUDE.md §3.2: role
   * assignments support expiration. Reviewer-required roles like
   * `super_admin` or `finance` ship with explicit expirations under
   * the admin tooling (TS-290).
   */
  readonly expiresAt?: Date | undefined;
}

/**
 * Role-assignment domain service. Owns the `identity.user_roles`
 * table and projects rows into the auth-sdk's `RoleAssignment`
 * shape used by `TokenService.signAccessToken` (TS-024).
 *
 * Surfaces:
 *  - `grant({userId, roleName, scope, grantedByUserId?, expiresAt?})`
 *  - `revoke({assignmentId, revokedByUserId?})`
 *  - `listForUser(userId, {now?, includeInactive?})`
 *  - `getActiveAssignments(userId, now?)` — hot path used at login
 *
 * Tenant-scoping enforcement (CLAUDE.md §3.2) lands as a Prisma
 * extension in TS-141; admin grants today are gated by the existing
 * `AccessTokenGuard` plus controller-level permission checks (TS-290
 * will add the granular RBAC tooling).
 */
@Injectable()
export class RoleAssignmentService {
  private readonly logger = new Logger(RoleAssignmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The default (non-transactional) write client. Cast through
   * `unknown` — the tenant-scope-extended client's delegate types are
   * a wider generic surface than the narrow structural contract
   * (same rationale as service-audit's `PgConsumerDedupStore` wiring);
   * the runtime shape matches exactly.
   */
  private writeClient(): RoleAssignmentWriteClient {
    return this.prisma as unknown as RoleAssignmentWriteClient;
  }

  /**
   * Issue a new role assignment. Throws:
   *  - `NotFoundException` if `roleName` does not exist (use the
   *    seed catalog or admin tooling to create it first).
   *  - `BadRequestException` if `scope` is malformed (e.g. tenant
   *    scope with empty tenantId).
   *  - `ConflictException` (409) when the role is ARCHIVED
   *    (`archivedAt` non-null, TS-290) — archived roles are hidden
   *    from assignment surfaces; existing assignments keep working
   *    but no new grants are issued.
   *  - `ConflictException` (409) when an identical ACTIVE
   *    assignment already exists — enforced at the DB boundary by
   *    the `user_roles_active_unique_idx` partial unique index
   *    (TS-024-followup-3); the resulting P2002 is translated here.
   *    Revoked history rows don't count: re-granting after a revoke
   *    succeeds.
   */
  async grant(
    input: GrantRoleInput,
    tx?: RoleAssignmentWriteClient,
  ): Promise<{ readonly id: string }> {
    const db = tx ?? this.writeClient();
    const { scopeType, scopeId } = encodeScope(input.scope);

    const role = await db.role.findUnique({
      where: { name: input.roleName },
      select: { id: true, name: true, archivedAt: true },
    });
    if (role === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `Role "${input.roleName}" does not exist.`,
      });
    }
    if (role.archivedAt !== null) {
      // Archived roles are hidden from assignment surfaces (TS-290) —
      // existing assignments keep working, but no NEW grants.
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Role "${input.roleName}" is archived and cannot be granted.`,
      });
    }

    let created: { readonly id: string };
    try {
      created = await db.userRole.create({
        data: {
          userId: input.userId,
          roleId: role.id,
          scopeType,
          scopeId,
          grantedByUserId: input.grantedByUserId ?? null,
          expiresAt: input.expiresAt ?? null,
        },
        select: { id: true },
      });
    } catch (err) {
      if (isPrismaKnownRequestError(err) && err.code === 'P2002') {
        this.logger.warn(
          {
            userId: input.userId,
            role: role.name,
            scope: input.scope.type,
            grantedByUserId: input.grantedByUserId ?? null,
            code: err.code,
          },
          'duplicate active role assignment rejected',
        );
        throw new ConflictException({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: `User already holds an active "${input.roleName}" assignment in the requested scope.`,
        });
      }
      throw err;
    }

    this.logger.log(
      {
        assignmentId: created.id,
        userId: input.userId,
        role: role.name,
        scope: input.scope.type,
        grantedByUserId: input.grantedByUserId ?? null,
        expiresAt: input.expiresAt?.toISOString() ?? null,
      },
      'role assignment granted',
    );

    return { id: created.id };
  }

  /**
   * Revoke an assignment by id. Idempotent: re-revoking is a no-op
   * (`revoked: false` returned, `revokedAt: null`). Returns
   * `revoked: true` plus the stamped instant only when the call
   * actually flipped a previously-active row.
   */
  async revoke(
    args: {
      readonly assignmentId: string;
      readonly revokedByUserId?: string | undefined;
    },
    tx?: RoleAssignmentWriteClient,
  ): Promise<{ readonly revoked: boolean; readonly revokedAt: Date | null }> {
    const db = tx ?? this.writeClient();
    const now = new Date();
    const result = await db.userRole.updateMany({
      where: { id: args.assignmentId, revokedAt: null },
      data: { revokedAt: now },
    });
    const revoked = result.count > 0;
    if (revoked) {
      this.logger.log(
        {
          assignmentId: args.assignmentId,
          revokedByUserId: args.revokedByUserId ?? null,
        },
        'role assignment revoked',
      );
    }
    return { revoked, revokedAt: revoked ? now : null };
  }

  /**
   * Return every assignment held by a user, projected into the
   * auth-sdk's `RoleAssignment` shape PLUS the database id. The
   * `active` flag reflects the snapshot at `options.now` —
   * `revoked_at IS NULL AND (expires_at IS NULL OR expires_at >
   * now)`.
   *
   * `includeInactive` defaults to false; admin tooling that needs
   * to display revoked / expired rows opts in.
   */
  async listForUser(
    userId: string,
    options: { readonly now?: Date; readonly includeInactive?: boolean } = {},
  ): Promise<readonly RoleAssignmentRecord[]> {
    const now = options.now ?? new Date();
    const includeInactive = options.includeInactive ?? false;

    // The select shape is identical across both branches; only the
    // `where` differs. Branching avoids fighting Prisma's
    // `WhereInput` type-narrowing for an optional active-filter
    // overlay (which would otherwise force a namespace import or a
    // type assertion). The explicit `ListRow[]` annotation pins the
    // structural shape Prisma returns under the `select` clause —
    // letting the conditional preserve a single concrete type
    // through `.map()`.
    type ListRow = {
      readonly id: string;
      readonly userId: string;
      readonly scopeType: DbScopeType;
      readonly scopeId: string | null;
      readonly grantedByUserId: string | null;
      readonly createdAt: Date;
      readonly expiresAt: Date | null;
      readonly revokedAt: Date | null;
      readonly role: {
        readonly name: string;
        readonly rolePermissions: ReadonlyArray<{
          readonly permission: { readonly resource: string; readonly action: string };
        }>;
      };
    };

    const rows: ListRow[] = includeInactive
      ? await this.prisma.userRole.findMany({
          where: { userId },
          select: SELECT_FOR_LIST,
          orderBy: { createdAt: 'asc' },
        })
      : await this.prisma.userRole.findMany({
          where: {
            userId,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          select: SELECT_FOR_LIST,
          orderBy: { createdAt: 'asc' },
        });

    return rows.map((row): RoleAssignmentRecord => {
      const scope = decodeScope(row.scopeType, row.scopeId);
      const permissions = row.role.rolePermissions.map(
        (rp) => `${rp.permission.resource}:${rp.permission.action}`,
      );
      const active =
        row.revokedAt === null &&
        (row.expiresAt === null || row.expiresAt.getTime() > now.getTime());
      const assignment: RoleAssignment = {
        name: row.role.name,
        scope,
        permissions,
        ...(row.expiresAt !== null ? { expiresAt: row.expiresAt.toISOString() } : {}),
      };
      return {
        id: row.id,
        userId: row.userId,
        assignment,
        active,
        grantedByUserId: row.grantedByUserId,
        createdAt: row.createdAt,
        revokedAt: row.revokedAt,
      };
    });
  }

  /**
   * Hot path used by `AuthService.issueSessionFor` to bake role
   * assignments into a freshly-issued access token's `roles` claim.
   *
   * Returns ONLY active assignments (revokedAt null AND not
   * expired) projected into the auth-sdk shape. The list is
   * deliberately denormalised (each assignment carries its own
   * permission set) so verifiers do not need to join role -> role
   * permissions at verify time.
   *
   * Performance: backed by `user_roles_user_active_idx` (compound
   * index on `(user_id, revoked_at, expires_at)`) — single index
   * scan plus a per-row role.rolePermissions fetch. For the
   * customer-facing roles whose permission set is empty in Phase
   * 1 the inner fetch is a single empty result.
   */
  async getActiveAssignments(
    userId: string,
    now: Date = new Date(),
  ): Promise<readonly RoleAssignment[]> {
    const records = await this.listForUser(userId, { now, includeInactive: false });
    return records.map((r) => r.assignment);
  }

  /**
   * `true` if the user holds any active assignment whose role name is
   * in `roleNames`. Active means: `revoked_at IS NULL AND (expires_at
   * IS NULL OR expires_at > now)`.
   *
   * Used by `AuthService.login` to enforce the "MFA mandatory for
   * admin staff" gate (TS-023-followup-1; CLAUDE.md §3.1) without
   * paying the cost of fetching + projecting the full assignment
   * graph. Returns early on the first matching row.
   *
   * Performance: backed by `user_roles_user_active_idx` (compound
   * index on `(user_id, revoked_at, expires_at)`) with an
   * inner-joined name filter that lets Postgres short-circuit; a
   * `findFirst` rather than `findMany` so the query plan caps at
   * one row. Empty `roleNames` returns false without hitting the
   * database.
   */
  async holdsAnyRole(
    userId: string,
    roleNames: readonly string[],
    now: Date = new Date(),
  ): Promise<boolean> {
    if (roleNames.length === 0) return false;
    const hit = await this.prisma.userRole.findFirst({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        role: { name: { in: [...roleNames] } },
      },
      select: { id: true },
    });
    return hit !== null;
  }
}

/**
 * `select` clause shared by `listForUser`'s two branches. Pulled out
 * as a `const` so both `findMany` calls produce the same Prisma
 * structural row shape, which the explicit `ListRow[]` annotation
 * captures.
 */
const SELECT_FOR_LIST = {
  id: true,
  userId: true,
  scopeType: true,
  scopeId: true,
  grantedByUserId: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
  role: {
    select: {
      name: true,
      rolePermissions: {
        select: {
          permission: { select: { resource: true, action: true } },
        },
      },
    },
  },
} as const;

/**
 * Encode an auth-sdk `TenantScope` into the `(scope_type, scope_id)`
 * pair stored on `identity.user_roles`. Validates the discriminated
 * union — `global` MUST NOT carry an id; `tenant`/`household` MUST.
 */
function encodeScope(scope: TenantScope): {
  readonly scopeType: DbScopeType;
  readonly scopeId: string | null;
} {
  switch (scope.type) {
    case 'global':
      return { scopeType: 'global', scopeId: null };
    case 'tenant': {
      if (scope.tenantId.length === 0) {
        throw new BadRequestException({
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'Tenant scope requires a non-empty tenantId.',
        });
      }
      return { scopeType: 'tenant', scopeId: scope.tenantId };
    }
    case 'household': {
      if (scope.householdId.length === 0) {
        throw new BadRequestException({
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'Household scope requires a non-empty householdId.',
        });
      }
      return { scopeType: 'household', scopeId: scope.householdId };
    }
  }
}

/**
 * Decode the `(scope_type, scope_id)` pair back into the auth-sdk
 * `TenantScope` discriminated union. Mirrors `encodeScope`.
 *
 * A row whose `scope_type = 'tenant'` (or `'household'`) but
 * `scope_id IS NULL` indicates DB drift — the migration's NOT NULL
 * vs. NULL columns plus the encode-side validation should prevent
 * this, but we surface the corruption explicitly rather than
 * silently coercing to global.
 */
function decodeScope(scopeType: DbScopeType, scopeId: string | null): TenantScope {
  switch (scopeType) {
    case 'global':
      return { type: 'global' };
    case 'tenant':
      if (scopeId === null) {
        throw new Error('user_roles row has scopeType=tenant but scopeId is null');
      }
      return { type: 'tenant', tenantId: scopeId };
    case 'household':
      if (scopeId === null) {
        throw new Error('user_roles row has scopeType=household but scopeId is null');
      }
      return { type: 'household', householdId: scopeId };
  }
}
