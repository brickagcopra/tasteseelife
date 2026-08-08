import { Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { PERMISSION_CATALOG, ROLE_CATALOG, formatPermission } from './seed-catalog';

/**
 * Surface used by `applyRbacCatalog` / `seedRbacCatalog`. Typed against
 * the actual Prisma surface we touch so the functions take a
 * `PrismaService` directly without depending on the
 * `Prisma.TransactionClient` namespace value-side (the same workaround
 * used by `RefreshTokenService` — see TS-021-followup-2 for the
 * underlying tooling issue).
 */
export interface RbacSeedClient {
  readonly permission: PrismaService['permission'];
  readonly role: PrismaService['role'];
  readonly rolePermission: PrismaService['rolePermission'];
}

export interface RbacSeedReport {
  readonly permissionsUpserted: number;
  readonly rolesUpserted: number;
  readonly rolePermissionsAttached: number;
  readonly rolePermissionsDetached: number;
  readonly skippedUnknownPermissions: readonly string[];
}

/** One portable permission entry as `applyRbacCatalog` consumes it. */
export interface RbacCatalogPermissionEntry {
  readonly resource: string;
  readonly action: string;
  readonly description: string | null;
}

/**
 * One portable role entry as `applyRbacCatalog` consumes it. Unlike
 * the seed constants, `isSystem` is explicit — the import path (TS-299)
 * writes custom roles with `isSystem: false` while the seed path
 * forces `true` for every catalog role.
 */
export interface RbacCatalogRoleEntry {
  readonly name: string;
  readonly description: string | null;
  readonly permissions: readonly string[];
  readonly isSystem: boolean;
}

/** A full catalog as `applyRbacCatalog` consumes it. */
export interface RbacCatalogInput {
  readonly permissions: readonly RbacCatalogPermissionEntry[];
  readonly roles: readonly RbacCatalogRoleEntry[];
}

/**
 * The in-code system catalog projected onto the parameterized input
 * shape — the default for `seedRbacCatalog`, keeping `pnpm seed:rbac`
 * behaviour byte-identical to the pre-TS-299 hardcoded loop.
 */
export const DEFAULT_RBAC_CATALOG: RbacCatalogInput = {
  permissions: PERMISSION_CATALOG.map((p) => ({
    resource: p.resource,
    action: p.action,
    description: p.description,
  })),
  roles: ROLE_CATALOG.map((r) => ({
    name: r.name,
    description: r.description,
    permissions: r.permissions,
    isSystem: true,
  })),
};

/**
 * The DTO-shaped snapshot of one role as it stood before/after an
 * apply — the same shape `roleAuditSnapshot` in
 * `role-catalog.service.ts` emits, so import-driven audit events render
 * uniformly in the RBAC History view.
 */
export interface RbacRoleSnapshot {
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly archivedAt: string | null;
  readonly permissions: readonly string[];
}

/** What happened to one role during an apply. */
export interface RbacRoleApplyChange {
  readonly name: string;
  readonly roleId: string;
  readonly kind: 'created' | 'updated' | 'unchanged';
  readonly before: RbacRoleSnapshot | null;
  readonly after: RbacRoleSnapshot;
}

export interface RbacCatalogApplyResult {
  readonly report: RbacSeedReport;
  /** Per-role outcome, catalog order — the import path's audit feed. */
  readonly roleChanges: readonly RbacRoleApplyChange[];
  /** `resource:action` keys that did not exist before this apply. */
  readonly permissionsCreated: readonly string[];
}

export interface RbacCatalogApplyOptions {
  /**
   * What to do when a role lists a permission string that cannot be
   * resolved. The seed path uses `skip` (warn + drop — defence in depth
   * behind the compile-time catalog guard); the import path pre-validates
   * and uses `reject` as its own backstop.
   */
  readonly unknownPermissionMode: 'skip' | 'reject';
  /**
   * When true, permission strings also resolve against rows already in
   * the target database (the import path — an imported role may
   * reference a permission the target knows but the envelope omits).
   * The seed path leaves this false: seeding resolves only against its
   * own catalog, exactly as before TS-299.
   */
  readonly resolveAgainstExisting: boolean;
}

/** Raised in `reject` mode when a role references unknown permissions. */
export class RbacUnknownPermissionsError extends Error {
  constructor(readonly offenders: readonly string[]) {
    super(`unknown permission(s): ${offenders.join(', ')}`);
    this.name = 'RbacUnknownPermissionsError';
  }
}

/**
 * Idempotently apply an RBAC catalog (PDD §10.2 + Appendix B) into
 * `identity.permissions`, `identity.roles`, and
 * `identity.role_permissions`. The shared reconcile core behind BOTH
 * `seedRbacCatalog` (in-code constants) and the TS-299 import path
 * (arbitrary validated envelopes).
 *
 * Idempotency contract:
 *  - Permissions are upserted on `(resource, action)`. Existing
 *    permissions keep their `id`; descriptions are refreshed.
 *  - Roles are upserted on `name`. Existing roles keep their `id`;
 *    descriptions are refreshed; `isSystem` is set from the entry.
 *  - Each catalog role's `role_permissions` set is reconciled to match
 *    the entry exactly: missing rows are inserted, surplus rows are
 *    removed. Roles NOT in the catalog are not touched.
 *
 * What this function does NOT do:
 *  - It never deletes rows in `permissions` (a permission removed from
 *    the catalog stays on disk; admin tooling owns that flow).
 *  - It never deletes a role (mirroring the same caution).
 *  - It never touches `user_roles`.
 *  - It does NOT guard system/sensitive roles — callers own policy
 *    (the seed path is by definition the system-catalog owner; the
 *    import service enforces the TS-299 guardrails before calling).
 *
 * MUST be called inside the caller's transaction so a partial failure
 * cannot leave the catalog half-applied (`seedRbacCatalog` wraps one;
 * the import service shares its audit-emitting transaction).
 */
export async function applyRbacCatalog(
  tx: RbacSeedClient,
  catalog: RbacCatalogInput,
  options: RbacCatalogApplyOptions,
): Promise<RbacCatalogApplyResult> {
  const logger = new Logger(applyRbacCatalog.name);

  // ── 1. Resolve the permission map: optionally pre-load what the
  //       target already has, then upsert the catalog's entries over it.
  const permissionIdByKey = new Map<string, string>();
  const existingPermissionKeys = new Set<string>();

  if (options.resolveAgainstExisting) {
    const existing: ReadonlyArray<{ id: string; resource: string; action: string }> =
      await tx.permission.findMany({
        select: { id: true, resource: true, action: true },
      });
    for (const row of existing) {
      permissionIdByKey.set(formatPermission(row), row.id);
      existingPermissionKeys.add(formatPermission(row));
    }
  } else {
    // Seed mode still needs to know which rows pre-exist so
    // `permissionsCreated` is accurate; project only the catalog's own
    // pairs to keep the query bounded to the catalog size.
    if (catalog.permissions.length > 0) {
      const existing: ReadonlyArray<{ resource: string; action: string }> =
        await tx.permission.findMany({
          where: {
            OR: catalog.permissions.map((p) => ({ resource: p.resource, action: p.action })),
          },
          select: { resource: true, action: true },
        });
      for (const row of existing) existingPermissionKeys.add(formatPermission(row));
    }
  }

  let permissionsUpserted = 0;
  const permissionsCreated: string[] = [];
  for (const entry of catalog.permissions) {
    const row = await tx.permission.upsert({
      where: {
        resource_action: { resource: entry.resource, action: entry.action },
      },
      create: {
        resource: entry.resource,
        action: entry.action,
        description: entry.description,
      },
      update: {
        description: entry.description,
      },
      select: { id: true, resource: true, action: true },
    });
    const key = formatPermission(row);
    permissionIdByKey.set(key, row.id);
    if (!existingPermissionKeys.has(key)) permissionsCreated.push(key);
    permissionsUpserted += 1;
  }

  // ── 2. Upsert catalog roles and reconcile their permission sets.
  let rolesUpserted = 0;
  let rolePermissionsAttached = 0;
  let rolePermissionsDetached = 0;
  const skippedUnknownPermissions: string[] = [];
  const roleChanges: RbacRoleApplyChange[] = [];

  for (const role of catalog.roles) {
    // Read the prior state first — the before-snapshot feeds the import
    // path's per-role audit events and the created/updated/unchanged
    // verdict. Explicit result annotation: the extended client's
    // inference collapses nested selects under this tsconfig's
    // strictness (same workaround as `RbacSeedClient` itself).
    const prior: {
      readonly id: string;
      readonly name: string;
      readonly description: string | null;
      readonly isSystem: boolean;
      readonly archivedAt: Date | null;
      readonly rolePermissions: ReadonlyArray<{
        readonly permission: { readonly resource: string; readonly action: string };
      }>;
    } | null = await tx.role.findUnique({
      where: { name: role.name },
      select: {
        id: true,
        name: true,
        description: true,
        isSystem: true,
        archivedAt: true,
        rolePermissions: {
          select: { permission: { select: { resource: true, action: true } } },
        },
      },
    });
    const before: RbacRoleSnapshot | null =
      prior === null
        ? null
        : {
            name: prior.name,
            description: prior.description,
            isSystem: prior.isSystem,
            archivedAt: prior.archivedAt?.toISOString() ?? null,
            permissions: prior.rolePermissions.map((rp) => formatPermission(rp.permission)).sort(),
          };

    const roleRow = await tx.role.upsert({
      where: { name: role.name },
      create: {
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
      },
      update: {
        description: role.description,
        isSystem: role.isSystem,
      },
      select: { id: true },
    });
    rolesUpserted += 1;

    // Resolve the entry's permission strings to ids. `skip` mode drops
    // unknowns with a warning (defence-in-depth — the compile-time
    // `as const satisfies` already prevents typos in the seed catalog
    // but a future hand-edit could introduce one); `reject` mode
    // collects and throws, rolling the caller's transaction back.
    const desiredPermissionIds = new Set<string>();
    const desiredPermissionKeys: string[] = [];
    const unknownForRole: string[] = [];
    for (const permission of role.permissions) {
      const id = permissionIdByKey.get(permission);
      if (id === undefined) {
        unknownForRole.push(`${role.name} → ${permission}`);
        if (options.unknownPermissionMode === 'skip') {
          logger.warn(
            { role: role.name, permission },
            'rbac catalog apply: skipping unknown permission for role',
          );
        }
        continue;
      }
      desiredPermissionIds.add(id);
      desiredPermissionKeys.push(permission);
    }
    if (unknownForRole.length > 0) {
      if (options.unknownPermissionMode === 'reject') {
        throw new RbacUnknownPermissionsError(unknownForRole);
      }
      skippedUnknownPermissions.push(...unknownForRole);
    }

    const existingLinks: ReadonlyArray<{ readonly permissionId: string }> =
      await tx.rolePermission.findMany({
        where: { roleId: roleRow.id },
        select: { permissionId: true },
      });
    const existingIds = new Set<string>(existingLinks.map((l) => l.permissionId));

    const toAttach: string[] = [];
    for (const want of desiredPermissionIds) {
      if (!existingIds.has(want)) toAttach.push(want);
    }
    const toDetach: string[] = [];
    for (const have of existingIds) {
      if (!desiredPermissionIds.has(have)) toDetach.push(have);
    }

    if (toAttach.length > 0) {
      await tx.rolePermission.createMany({
        data: toAttach.map((permissionId) => ({ roleId: roleRow.id, permissionId })),
      });
      rolePermissionsAttached += toAttach.length;
    }
    if (toDetach.length > 0) {
      await tx.rolePermission.deleteMany({
        where: { roleId: roleRow.id, permissionId: { in: toDetach } },
      });
      rolePermissionsDetached += toDetach.length;
    }

    const after: RbacRoleSnapshot = {
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      archivedAt: before?.archivedAt ?? null,
      permissions: [...desiredPermissionKeys].sort(),
    };
    const kind: RbacRoleApplyChange['kind'] =
      before === null ? 'created' : snapshotsEqual(before, after) ? 'unchanged' : 'updated';
    roleChanges.push({ name: role.name, roleId: roleRow.id, kind, before, after });
  }

  logger.log(
    {
      permissionsUpserted,
      rolesUpserted,
      rolePermissionsAttached,
      rolePermissionsDetached,
      skippedUnknownPermissionsCount: skippedUnknownPermissions.length,
    },
    'rbac catalog apply completed',
  );

  return {
    report: {
      permissionsUpserted,
      rolesUpserted,
      rolePermissionsAttached,
      rolePermissionsDetached,
      skippedUnknownPermissions,
    },
    roleChanges,
    permissionsCreated,
  };
}

function snapshotsEqual(a: RbacRoleSnapshot, b: RbacRoleSnapshot): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.isSystem === b.isSystem &&
    a.permissions.length === b.permissions.length &&
    a.permissions.every((p, i) => p === b.permissions[i])
  );
}

/**
 * Idempotently load an RBAC catalog into the database — by default the
 * in-code system catalog (PDD §10.2 + Appendix B), preserving the
 * pre-TS-299 `pnpm seed:rbac` behaviour exactly (unknown permissions
 * warn + skip; every role written `isSystem: true` via
 * `DEFAULT_RBAC_CATALOG`).
 *
 * Runs inside a single transaction so a partial failure cannot leave
 * the catalog half-applied. The TS-299 import path does NOT call this
 * wrapper — it shares `applyRbacCatalog` inside its own audit-emitting
 * transaction (see `rbac-catalog-port.service.ts`).
 */
export async function seedRbacCatalog(
  prisma: PrismaService,
  catalog: RbacCatalogInput = DEFAULT_RBAC_CATALOG,
): Promise<RbacSeedReport> {
  const result = await prisma.$transaction(async (tx: RbacSeedClient) =>
    applyRbacCatalog(tx, catalog, {
      unknownPermissionMode: 'skip',
      resolveAgainstExisting: false,
    }),
  );
  return result.report;
}
