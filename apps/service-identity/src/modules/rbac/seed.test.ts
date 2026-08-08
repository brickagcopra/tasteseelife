import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { PERMISSION_CATALOG, ROLE_CATALOG } from './seed-catalog';
import {
  applyRbacCatalog,
  RbacUnknownPermissionsError,
  seedRbacCatalog,
  type RbacCatalogInput,
  type RbacSeedClient,
} from './seed';

/**
 * In-memory fake of the Prisma surface applyRbacCatalog touches:
 *   - permission.upsert (on (resource, action)) / findMany
 *   - role.upsert (on name) / findUnique (prior-state read)
 *   - rolePermission.findMany / createMany / deleteMany
 *
 * Plus `$transaction(cb)` which simply invokes the callback against
 * the same fake — the seed function uses one transaction; the fake
 * does not need to model rollback.
 */
interface PermissionRow {
  id: string;
  resource: string;
  action: string;
  description: string | null;
}
interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
}
interface RolePermissionRow {
  roleId: string;
  permissionId: string;
}

function buildFakePrisma(): {
  prisma: PrismaService;
  permissions: Map<string, PermissionRow>;
  roles: Map<string, RoleRow>;
  rolePermissions: RolePermissionRow[];
  permissionUpsertCalls: ReturnType<typeof vi.fn>;
  roleUpsertCalls: ReturnType<typeof vi.fn>;
} {
  const permissions = new Map<string, PermissionRow>();
  const roles = new Map<string, RoleRow>();
  const rolePermissions: RolePermissionRow[] = [];
  let pCounter = 0;
  let rCounter = 0;

  const permissionUpsertCalls = vi.fn(
    async (req: {
      where: { resource_action: { resource: string; action: string } };
      create: { resource: string; action: string; description: string | null };
      update: { description: string | null };
    }) => {
      const key = `${req.where.resource_action.resource}:${req.where.resource_action.action}`;
      let existing = permissions.get(key);
      if (existing === undefined) {
        pCounter += 1;
        existing = {
          id: `p_${pCounter}`,
          resource: req.create.resource,
          action: req.create.action,
          description: req.create.description,
        };
        permissions.set(key, existing);
      } else {
        existing.description = req.update.description;
      }
      return { id: existing.id, resource: existing.resource, action: existing.action };
    },
  );

  const roleUpsertCalls = vi.fn(
    async (req: {
      where: { name: string };
      create: { name: string; description: string | null; isSystem: boolean };
      update: { description: string | null; isSystem: boolean };
    }) => {
      let existing = roles.get(req.where.name);
      if (existing === undefined) {
        rCounter += 1;
        existing = {
          id: `r_${rCounter}`,
          name: req.where.name,
          description: req.create.description,
          isSystem: req.create.isSystem,
        };
        roles.set(req.where.name, existing);
      } else {
        existing.description = req.update.description;
        existing.isSystem = req.update.isSystem;
      }
      return { id: existing.id };
    },
  );

  const permissionFindMany = vi.fn(
    async (req?: { where?: { OR: ReadonlyArray<{ resource: string; action: string }> } }) => {
      const all = [...permissions.values()];
      const filtered =
        req?.where?.OR !== undefined
          ? all.filter((p) =>
              req.where!.OR.some((c) => c.resource === p.resource && c.action === p.action),
            )
          : all;
      return filtered.map((p) => ({ id: p.id, resource: p.resource, action: p.action }));
    },
  );

  const roleFindUnique = vi.fn(async (req: { where: { name: string } }) => {
    const row = roles.get(req.where.name);
    if (row === undefined) return null;
    const permissionById = new Map([...permissions.values()].map((p) => [p.id, p]));
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      isSystem: row.isSystem,
      archivedAt: null,
      rolePermissions: rolePermissions
        .filter((rp) => rp.roleId === row.id)
        .map((rp) => {
          const p = permissionById.get(rp.permissionId);
          return {
            permission: { resource: p?.resource ?? '?', action: p?.action ?? '?' },
          };
        }),
    };
  });

  const surface = {
    permission: { upsert: permissionUpsertCalls, findMany: permissionFindMany },
    role: { upsert: roleUpsertCalls, findUnique: roleFindUnique },
    rolePermission: {
      findMany: vi.fn(async (req: { where: { roleId: string }; select: { permissionId: true } }) =>
        rolePermissions
          .filter((rp) => rp.roleId === req.where.roleId)
          .map((rp) => ({ permissionId: rp.permissionId })),
      ),
      createMany: vi.fn(
        async (req: { data: ReadonlyArray<{ roleId: string; permissionId: string }> }) => {
          for (const row of req.data) rolePermissions.push({ ...row });
          return { count: req.data.length };
        },
      ),
      deleteMany: vi.fn(
        async (req: { where: { roleId: string; permissionId: { in: readonly string[] } } }) => {
          let removed = 0;
          for (let i = rolePermissions.length - 1; i >= 0; i -= 1) {
            const row = rolePermissions[i];
            if (
              row !== undefined &&
              row.roleId === req.where.roleId &&
              req.where.permissionId.in.includes(row.permissionId)
            ) {
              rolePermissions.splice(i, 1);
              removed += 1;
            }
          }
          return { count: removed };
        },
      ),
    },
    $transaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(surface)),
  };

  return {
    prisma: surface as unknown as PrismaService,
    permissions,
    roles,
    rolePermissions,
    permissionUpsertCalls,
    roleUpsertCalls,
  };
}

describe('seedRbacCatalog — first-run seed', () => {
  it('inserts every permission from PERMISSION_CATALOG', async () => {
    const { prisma, permissions } = buildFakePrisma();
    const report = await seedRbacCatalog(prisma);
    expect(report.permissionsUpserted).toBe(PERMISSION_CATALOG.length);
    for (const p of PERMISSION_CATALOG) {
      expect(permissions.has(`${p.resource}:${p.action}`)).toBe(true);
    }
  });

  it('inserts every system role from ROLE_CATALOG with isSystem=true', async () => {
    const { prisma, roles } = buildFakePrisma();
    const report = await seedRbacCatalog(prisma);
    expect(report.rolesUpserted).toBe(ROLE_CATALOG.length);
    for (const r of ROLE_CATALOG) {
      expect(roles.has(r.name)).toBe(true);
      expect(roles.get(r.name)?.isSystem).toBe(true);
    }
  });

  it('attaches permissions to roles per the catalog (Appendix B reflected)', async () => {
    const { prisma, rolePermissions, roles, permissions } = buildFakePrisma();
    await seedRbacCatalog(prisma);

    // Spot-check finance: should hold accounting:close_period, finance:adjust,
    // user:read, subscription:write, audit:read.
    const financeRole = roles.get('finance');
    if (financeRole === undefined) throw new Error('finance role missing');
    const financeRpIds = rolePermissions
      .filter((rp) => rp.roleId === financeRole.id)
      .map((rp) => rp.permissionId);
    const expectedPermStrings = [
      'accounting:close_period',
      'finance:adjust',
      'user:read',
      'subscription:write',
      'audit:read',
    ];
    const expectedIds = expectedPermStrings.map((s) => permissions.get(s)?.id ?? '');
    expect(new Set(financeRpIds)).toEqual(new Set(expectedIds));

    // Spot-check super_admin: holds every Appendix B permission +
    // finance:adjust + the TS-224 concierge:read / concierge:write pair +
    // the TS-251 academy:read / academy:write pair + the TS-271 ads:read /
    // ads:write pair + the TS-277 marketing:approve_creative gate +
    // the TS-290 rbac:read / rbac:write pair + the TS-297
    // user:impersonate gate + the TS-303c1 trust_safety:read /
    // trust_safety:write pair + the TS-305a provider:read gate + the
    // TS-309a privacy:read / privacy:write pair + the TS-282-followup-5b
    // media:read gate.
    const superAdminRole = roles.get('super_admin');
    if (superAdminRole === undefined) throw new Error('super_admin role missing');
    const saRpIds = rolePermissions
      .filter((rp) => rp.roleId === superAdminRole.id)
      .map((rp) => rp.permissionId);
    expect(saRpIds.length).toBe(25);
  });

  it('seeds customer-facing roles with empty permission sets', async () => {
    const { prisma, rolePermissions, roles } = buildFakePrisma();
    await seedRbacCatalog(prisma);

    for (const name of [
      'family_payer',
      'family_observer',
      'senior_user',
      'provider',
      'partner_admin',
      'partner_member',
      'student',
    ]) {
      const role = roles.get(name);
      if (role === undefined) throw new Error(`${name} missing`);
      const rps = rolePermissions.filter((rp) => rp.roleId === role.id);
      expect(rps).toEqual([]);
    }
  });
});

describe('seedRbacCatalog — idempotency', () => {
  it('a second run inserts zero new role-permission rows and detaches none', async () => {
    const { prisma, rolePermissions } = buildFakePrisma();
    const first = await seedRbacCatalog(prisma);
    const initialAttached = first.rolePermissionsAttached;
    expect(initialAttached).toBeGreaterThan(0);
    const initialRpCount = rolePermissions.length;

    const second = await seedRbacCatalog(prisma);
    expect(second.rolePermissionsAttached).toBe(0);
    expect(second.rolePermissionsDetached).toBe(0);
    expect(rolePermissions.length).toBe(initialRpCount);
  });

  it('preserves role + permission ids across runs (upsert, not delete-and-recreate)', async () => {
    const { prisma, roles, permissions } = buildFakePrisma();
    await seedRbacCatalog(prisma);
    const beforeRoleIds = new Map([...roles.entries()].map(([name, row]) => [name, row.id]));
    const beforePermIds = new Map([...permissions.entries()].map(([key, row]) => [key, row.id]));

    await seedRbacCatalog(prisma);

    for (const [name, id] of beforeRoleIds) {
      expect(roles.get(name)?.id).toBe(id);
    }
    for (const [key, id] of beforePermIds) {
      expect(permissions.get(key)?.id).toBe(id);
    }
  });
});

describe('seedRbacCatalog — reconciliation', () => {
  it('detaches a stray role-permission row that is not in the catalog', async () => {
    const { prisma, rolePermissions, roles, permissions } = buildFakePrisma();
    // Run once to establish ids.
    await seedRbacCatalog(prisma);

    // Pollute by attaching coupon:create to content_editor (not in
    // catalog) — simulates a stale grant from a prior catalog version.
    const contentEditor = roles.get('content_editor');
    const couponCreate = permissions.get('coupon:create');
    if (contentEditor === undefined || couponCreate === undefined) {
      throw new Error('precondition: content_editor + coupon:create must exist');
    }
    rolePermissions.push({ roleId: contentEditor.id, permissionId: couponCreate.id });
    const before = rolePermissions.length;

    const report = await seedRbacCatalog(prisma);
    expect(report.rolePermissionsDetached).toBeGreaterThanOrEqual(1);
    expect(rolePermissions.length).toBe(before - report.rolePermissionsDetached);

    // The stray row is gone.
    expect(
      rolePermissions.find(
        (rp) => rp.roleId === contentEditor.id && rp.permissionId === couponCreate.id,
      ),
    ).toBeUndefined();
  });

  it('attaches a missing role-permission row that the catalog requires', async () => {
    const { prisma, rolePermissions, roles, permissions } = buildFakePrisma();
    await seedRbacCatalog(prisma);

    // Strip finance's `accounting:close_period` link to simulate
    // schema drift / a partial earlier seed.
    const finance = roles.get('finance');
    const closePeriod = permissions.get('accounting:close_period');
    if (finance === undefined || closePeriod === undefined) throw new Error('precondition');
    const idx = rolePermissions.findIndex(
      (rp) => rp.roleId === finance.id && rp.permissionId === closePeriod.id,
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    rolePermissions.splice(idx, 1);

    const report = await seedRbacCatalog(prisma);
    expect(report.rolePermissionsAttached).toBe(1);
    expect(
      rolePermissions.find((rp) => rp.roleId === finance.id && rp.permissionId === closePeriod.id),
    ).toBeDefined();
  });
});

describe('applyRbacCatalog — parameterized catalogs (TS-299)', () => {
  const CUSTOM_CATALOG: RbacCatalogInput = {
    permissions: [
      { resource: 'widget', action: 'read', description: 'Read widgets.' },
      { resource: 'widget', action: 'write', description: null },
    ],
    roles: [
      {
        name: 'widget_operator',
        description: 'Operates widgets.',
        permissions: ['widget:read', 'widget:write'],
        isSystem: false,
      },
    ],
  };

  function asClient(prisma: PrismaService): RbacSeedClient {
    return prisma as unknown as RbacSeedClient;
  }

  it('applies an arbitrary catalog with isSystem taken from the entry', async () => {
    const { prisma, roles } = buildFakePrisma();
    const result = await applyRbacCatalog(asClient(prisma), CUSTOM_CATALOG, {
      unknownPermissionMode: 'reject',
      resolveAgainstExisting: true,
    });
    expect(roles.get('widget_operator')?.isSystem).toBe(false);
    expect(result.report.rolesUpserted).toBe(1);
    expect(result.permissionsCreated).toEqual(['widget:read', 'widget:write']);
  });

  it('reports created / updated / unchanged per role across successive applies', async () => {
    const { prisma } = buildFakePrisma();
    const first = await applyRbacCatalog(asClient(prisma), CUSTOM_CATALOG, {
      unknownPermissionMode: 'reject',
      resolveAgainstExisting: true,
    });
    expect(first.roleChanges).toHaveLength(1);
    expect(first.roleChanges[0]?.kind).toBe('created');
    expect(first.roleChanges[0]?.before).toBeNull();

    const second = await applyRbacCatalog(asClient(prisma), CUSTOM_CATALOG, {
      unknownPermissionMode: 'reject',
      resolveAgainstExisting: true,
    });
    expect(second.roleChanges[0]?.kind).toBe('unchanged');
    expect(second.permissionsCreated).toEqual([]);

    const narrowed: RbacCatalogInput = {
      ...CUSTOM_CATALOG,
      roles: [{ ...CUSTOM_CATALOG.roles[0]!, permissions: ['widget:read'] }],
    };
    const third = await applyRbacCatalog(asClient(prisma), narrowed, {
      unknownPermissionMode: 'reject',
      resolveAgainstExisting: true,
    });
    expect(third.roleChanges[0]?.kind).toBe('updated');
    expect(third.roleChanges[0]?.before?.permissions).toEqual(['widget:read', 'widget:write']);
    expect(third.roleChanges[0]?.after.permissions).toEqual(['widget:read']);
    expect(third.report.rolePermissionsDetached).toBe(1);
  });

  it('resolves against target permissions when resolveAgainstExisting is set', async () => {
    const { prisma } = buildFakePrisma();
    // Seed the full system catalog first, then apply a role-only
    // envelope that references a target-known permission it does not
    // itself define.
    await seedRbacCatalog(prisma);
    const roleOnly: RbacCatalogInput = {
      permissions: [],
      roles: [
        {
          name: 'auditor_helper',
          description: null,
          permissions: ['audit:read'],
          isSystem: false,
        },
      ],
    };
    const result = await applyRbacCatalog(asClient(prisma), roleOnly, {
      unknownPermissionMode: 'reject',
      resolveAgainstExisting: true,
    });
    expect(result.roleChanges[0]?.after.permissions).toEqual(['audit:read']);
  });

  it('rejects unknown permission strings in reject mode, naming offenders', async () => {
    const { prisma } = buildFakePrisma();
    const bad: RbacCatalogInput = {
      permissions: [],
      roles: [
        {
          name: 'ghost_role',
          description: null,
          permissions: ['ghost:walk'],
          isSystem: false,
        },
      ],
    };
    await expect(
      applyRbacCatalog(asClient(prisma), bad, {
        unknownPermissionMode: 'reject',
        resolveAgainstExisting: true,
      }),
    ).rejects.toThrowError(RbacUnknownPermissionsError);
  });

  it('default-arg seedRbacCatalog matches the in-code catalog (regression pin)', async () => {
    const { prisma, roles, permissions } = buildFakePrisma();
    const report = await seedRbacCatalog(prisma);
    expect(report.permissionsUpserted).toBe(PERMISSION_CATALOG.length);
    expect(report.rolesUpserted).toBe(ROLE_CATALOG.length);
    expect(report.skippedUnknownPermissions).toEqual([]);
    for (const r of ROLE_CATALOG) expect(roles.get(r.name)?.isSystem).toBe(true);
    for (const p of PERMISSION_CATALOG) {
      expect(permissions.has(`${p.resource}:${p.action}`)).toBe(true);
    }
  });
});
