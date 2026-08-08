import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { PrismaService, type PrismaTransactionClient } from '../../prisma/prisma.service';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { AuditEmitter } from '@taste-and-see/nest-audit';
import { RBAC_AUDIT_RESOURCE } from './audit-resources';

/**
 * Duck-typed narrowing for Prisma's `KnownRequestError` — same
 * rationale as the sibling guard in `role-assignment.service.ts` /
 * `auth.service.ts`. P2002 = unique constraint violation.
 */
interface PrismaKnownRequestError {
  readonly code: string;
}

function isPrismaKnownRequestError(err: unknown): err is PrismaKnownRequestError {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string';
}

/*
 * The narrow structural `RoleCatalogTxClient` that used to live here was a
 * workaround for the postinstall STUB's untyped `$transaction` — it existed
 * only to stop the callback param collapsing to `any`. Now that the service
 * compiles against its own generated client, the real
 * `Prisma.TransactionClient` (re-exported as `PrismaTransactionClient`) is
 * both accurate and assignable, so the hand-written shape is gone. Keeping
 * it would have been actively harmful: it did not satisfy the generated
 * interactive-transaction overload, so TypeScript silently fell through to
 * the array form of `$transaction` and typed the result as `any[]`.
 */

/** One catalog permission row as projected for the admin surface. */
export interface PermissionCatalogRow {
  readonly id: string;
  readonly resource: string;
  readonly action: string;
  readonly description: string | null;
}

/**
 * One role as projected for the admin surface — permission strings
 * inline (canonical `resource:action`, sorted for stable diffs).
 */
export interface RoleCatalogRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly archivedAt: Date | null;
  readonly permissions: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateRoleInput {
  readonly name: string;
  readonly description?: string | undefined;
  /** Canonical `resource:action` strings; every one must exist in the catalog. */
  readonly permissions: readonly string[];
  readonly actor: AuditActorContext;
}

export interface UpdateRoleInput {
  readonly roleId: string;
  readonly name?: string | undefined;
  /** `null` clears the description; `undefined` leaves it untouched. */
  readonly description?: string | null | undefined;
  /** When present, REPLACES the whole permission set atomically. */
  readonly permissions?: readonly string[] | undefined;
  readonly actor: AuditActorContext;
}

export interface ArchiveRoleInput {
  readonly roleId: string;
  readonly note?: string | undefined;
  readonly actor: AuditActorContext;
}

/**
 * Role-DEFINITION catalog service (TS-290; PRD §10.12; PDD §10.3) —
 * CRUD over `identity.roles` / `identity.role_permissions`. Distinct
 * from `RoleAssignmentService`, which owns granting roles TO users
 * (`identity.user_roles`).
 *
 * **System-role protection.** `isSystem: true` rows are owned by the
 * seed catalog (`seed-catalog.ts`); every mutation on one is rejected
 * with a 409 here — this is the service-layer protection the schema
 * doc-comments promise (the flag is provenance, not a DB constraint).
 *
 * **Archive, not delete.** Roles are never hard-deleted (`user_roles`
 * history FKs them, ON DELETE RESTRICT). `archiveRole` sets
 * `archived_at`; archived roles are rejected by
 * `RoleAssignmentService.grant` and read-only here (mutating an
 * archived role is a 409 — no restore endpoint yet; see
 * TS-290-followup on unarchive if product wants it).
 *
 * **Audit emission.** Every mutation emits a durable
 * `audit.action_recorded` outbox event (TS-295 — the RBAC slice of
 * TS-126-followup-5) INSIDE its transaction via `AuditEmitter`, so
 * the audit record commits atomically with the state change, plus the
 * structured `logger.log` line the scaffold always carried.
 */
@Injectable()
export class RoleCatalogService {
  private readonly logger = new Logger(RoleCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEmitter,
  ) {}

  /** Every catalog permission, ordered `(resource, action)`. */
  async listPermissions(): Promise<readonly PermissionCatalogRow[]> {
    return this.prisma.permission.findMany({
      select: { id: true, resource: true, action: true, description: true },
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
  }

  /**
   * Every role with its permission strings inline. Archived roles are
   * excluded unless `includeArchived`. Ordered by name.
   */
  async listRoles(
    options: { readonly includeArchived?: boolean } = {},
  ): Promise<readonly RoleCatalogRow[]> {
    const includeArchived = options.includeArchived ?? false;
    const rows = await this.prisma.role.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      select: SELECT_FOR_ROLE,
      orderBy: { name: 'asc' },
    });
    return rows.map(toRoleRow);
  }

  /** One role by id, or null. Archived roles ARE returned (read is fine). */
  async getRole(roleId: string): Promise<RoleCatalogRow | null> {
    const row = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: SELECT_FOR_ROLE,
    });
    return row === null ? null : toRoleRow(row);
  }

  /**
   * Create a CUSTOM role (`isSystem: false` always). Throws:
   *  - `BadRequestException` (400) when any permission string is not
   *    in the catalog — the problem details name the offenders.
   *  - `ConflictException` (409) on a name collision (P2002 on
   *    `roles.name` — custom roles share the namespace with system
   *    roles so a custom role can never shadow a seeded one).
   */
  async createRole(input: CreateRoleInput): Promise<RoleCatalogRow> {
    const permissionIds = await this.resolvePermissionIds(input.permissions);

    let created: RoleWithPermissionsSelect;
    try {
      created = await this.prisma.$transaction(
        async (tx: PrismaTransactionClient & OutboxRawExecutor) => {
          const role = await tx.role.create({
            data: {
              name: input.name,
              description: input.description ?? null,
              isSystem: false,
            },
            select: { id: true },
          });
          if (permissionIds.length > 0) {
            await tx.rolePermission.createMany({
              data: permissionIds.map((permissionId) => ({
                roleId: role.id,
                permissionId,
              })),
            });
          }
          const full = await tx.role.findUniqueOrThrow({
            where: { id: role.id },
            select: SELECT_FOR_ROLE,
          });
          await this.audit.emit(tx, input.actor, {
            action: 'rbac_role:create',
            resourceKind: RBAC_AUDIT_RESOURCE.role,
            resourceId: full.id,
            before: null,
            after: roleAuditSnapshot(toRoleRow(full)),
          });
          return full;
        },
      );
    } catch (err) {
      if (isPrismaKnownRequestError(err) && err.code === 'P2002') {
        this.logger.warn(
          { name: input.name, actorId: input.actor.actorUserId, code: err.code },
          'role create rejected: name already exists',
        );
        throw new ConflictException({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: `A role named "${input.name}" already exists.`,
        });
      }
      throw err;
    }

    const row = toRoleRow(created);
    this.logger.log(
      {
        action: 'rbac_role:create',
        actorId: input.actor.actorUserId,
        roleId: row.id,
        after: { name: row.name, description: row.description, permissions: row.permissions },
      },
      'custom role created',
    );
    return row;
  }

  /**
   * Partial update of a CUSTOM role. `permissions` (when present)
   * replaces the whole set atomically (deleteMany + createMany in one
   * transaction). Throws:
   *  - `NotFoundException` (404) — unknown id.
   *  - `ConflictException` (409) — system role (seed-owned), archived
   *    role (read-only), or a rename collision (P2002).
   *  - `BadRequestException` (400) — unknown permission strings.
   */
  async updateRole(input: UpdateRoleInput): Promise<RoleCatalogRow> {
    const existing = await this.prisma.role.findUnique({
      where: { id: input.roleId },
      select: SELECT_FOR_ROLE,
    });
    if (existing === null) throw roleNotFound(input.roleId);
    this.rejectSeedOwnedOrArchived(existing, 'update');

    const permissionIds =
      input.permissions !== undefined ? await this.resolvePermissionIds(input.permissions) : null;

    let updated: RoleWithPermissionsSelect;
    try {
      updated = await this.prisma.$transaction(
        async (tx: PrismaTransactionClient & OutboxRawExecutor) => {
          await tx.role.update({
            where: { id: input.roleId },
            data: {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
            },
            select: { id: true },
          });
          if (permissionIds !== null) {
            await tx.rolePermission.deleteMany({ where: { roleId: input.roleId } });
            if (permissionIds.length > 0) {
              await tx.rolePermission.createMany({
                data: permissionIds.map((permissionId) => ({
                  roleId: input.roleId,
                  permissionId,
                })),
              });
            }
          }
          const full = await tx.role.findUniqueOrThrow({
            where: { id: input.roleId },
            select: SELECT_FOR_ROLE,
          });
          await this.audit.emit(tx, input.actor, {
            action: 'rbac_role:update',
            resourceKind: RBAC_AUDIT_RESOURCE.role,
            resourceId: full.id,
            before: roleAuditSnapshot(toRoleRow(existing)),
            after: roleAuditSnapshot(toRoleRow(full)),
          });
          return full;
        },
      );
    } catch (err) {
      if (isPrismaKnownRequestError(err) && err.code === 'P2002') {
        this.logger.warn(
          { roleId: input.roleId, name: input.name, actorId: input.actor.actorUserId },
          'role update rejected: target name already exists',
        );
        throw new ConflictException({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: `A role named "${input.name ?? ''}" already exists.`,
        });
      }
      throw err;
    }

    const before = toRoleRow(existing);
    const after = toRoleRow(updated);
    this.logger.log(
      {
        action: 'rbac_role:update',
        actorId: input.actor.actorUserId,
        roleId: after.id,
        before: {
          name: before.name,
          description: before.description,
          permissions: before.permissions,
        },
        after: {
          name: after.name,
          description: after.description,
          permissions: after.permissions,
        },
      },
      'custom role updated',
    );
    return after;
  }

  /**
   * Archive a CUSTOM role (sets `archived_at`). Existing assignments
   * keep working until individually revoked; new grants are rejected
   * by `RoleAssignmentService.grant`. Throws 404 unknown, 409 system
   * role, 409 already archived.
   */
  async archiveRole(input: ArchiveRoleInput): Promise<RoleCatalogRow> {
    const existing = await this.prisma.role.findUnique({
      where: { id: input.roleId },
      select: SELECT_FOR_ROLE,
    });
    if (existing === null) throw roleNotFound(input.roleId);
    this.rejectSeedOwnedOrArchived(existing, 'archive');

    // Transactional so the audit event commits atomically with the
    // archive flip (CLAUDE.md §5.3) — the mutation was a bare update
    // before TS-295 added the emission.
    const updated: RoleWithPermissionsSelect = await this.prisma.$transaction(
      async (tx: PrismaTransactionClient) => {
        const row: RoleWithPermissionsSelect = await tx.role.update({
          where: { id: input.roleId },
          data: { archivedAt: new Date() },
          select: SELECT_FOR_ROLE,
        });
        await this.audit.emit(tx, input.actor, {
          action: 'rbac_role:archive',
          resourceKind: RBAC_AUDIT_RESOURCE.role,
          resourceId: row.id,
          before: roleAuditSnapshot(toRoleRow(existing)),
          after: {
            ...roleAuditSnapshot(toRoleRow(row)),
            note: input.note ?? null,
          },
        });
        return row;
      },
    );

    const after = toRoleRow(updated);
    this.logger.log(
      {
        action: 'rbac_role:archive',
        actorId: input.actor.actorUserId,
        roleId: after.id,
        note: input.note ?? null,
        before: { archivedAt: null },
        after: { archivedAt: after.archivedAt?.toISOString() ?? null },
      },
      'custom role archived',
    );
    return after;
  }

  /**
   * Resolve `resource:action` strings to permission ids. Rejects with
   * a 400 naming every unknown string — a typo'd permission must
   * never silently attach nothing.
   */
  private async resolvePermissionIds(permissions: readonly string[]): Promise<readonly string[]> {
    if (permissions.length === 0) return [];

    const pairs = permissions.map((p) => {
      const idx = p.indexOf(':');
      return { resource: p.slice(0, idx), action: p.slice(idx + 1) };
    });
    const rows: ReadonlyArray<{ id: string; resource: string; action: string }> =
      await this.prisma.permission.findMany({
        where: { OR: pairs.map((pair) => ({ resource: pair.resource, action: pair.action })) },
        select: { id: true, resource: true, action: true },
      });

    const idByString = new Map<string, string>();
    for (const r of rows) idByString.set(`${r.resource}:${r.action}`, r.id);
    const unknown = permissions.filter((p) => !idByString.has(p));
    if (unknown.length > 0) {
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: `Unknown permission(s): ${unknown.join(', ')}. Permissions are seeded from the catalog — see seed-catalog.ts.`,
        unknownPermissions: unknown,
      });
    }
    // Preserve the caller's order for deterministic createMany rows.
    return permissions.map((p) => {
      const id = idByString.get(p);
      if (id === undefined) throw new Error('unreachable: unknown permission after check');
      return id;
    });
  }

  /**
   * System roles are seed-owned; archived roles are read-only. Both
   * reject with 409 (the resource exists — the state forbids the
   * mutation — so 409 over 403, mirroring the suspend/reinstate
   * illegal-transition idiom).
   */
  private rejectSeedOwnedOrArchived(
    role: { readonly name: string; readonly isSystem: boolean; readonly archivedAt: Date | null },
    attempted: 'update' | 'archive',
  ): void {
    if (role.isSystem) {
      this.logger.warn(
        { role: role.name, attempted },
        'role mutation rejected: system roles are seed-owned and read-only',
      );
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Role "${role.name}" is a system role — system roles are owned by the seed catalog and cannot be ${attempted}d via the admin tooling.`,
      });
    }
    if (role.archivedAt !== null) {
      this.logger.warn({ role: role.name, attempted }, 'role mutation rejected: role is archived');
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Role "${role.name}" is archived and read-only.`,
      });
    }
  }
}

/**
 * Shared `select` for every role read — keeps the structural row
 * shape identical across list / detail / mutation return paths.
 */
const SELECT_FOR_ROLE = {
  id: true,
  name: true,
  description: true,
  isSystem: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  rolePermissions: {
    select: {
      permission: { select: { resource: true, action: true } },
    },
  },
} as const;

type RoleWithPermissionsSelect = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly rolePermissions: ReadonlyArray<{
    readonly permission: { readonly resource: string; readonly action: string };
  }>;
};

/**
 * The DTO-projected role snapshot an audit event carries as its
 * before/after diff (never a raw Prisma row — CLAUDE.md §3.3). Dates
 * become ISO strings; created/updated timestamps stay off the diff
 * (the audit row has its own `occurredAt`).
 */
function roleAuditSnapshot(row: RoleCatalogRow): Record<string, unknown> {
  return {
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    permissions: [...row.permissions],
  };
}

function toRoleRow(row: RoleWithPermissionsSelect): RoleCatalogRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    archivedAt: row.archivedAt,
    permissions: row.rolePermissions
      .map((rp) => `${rp.permission.resource}:${rp.permission.action}`)
      .sort(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function roleNotFound(roleId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: `Role ${roleId.length <= 32 ? roleId : `${roleId.slice(0, 29)}...`} not found.`,
  });
}
