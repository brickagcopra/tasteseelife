import { RBAC_CATALOG_FORMAT_VERSION, type RbacCatalogEnvelope } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import {
  RbacCatalogImportRefusedError,
  RbacCatalogImportValidationError,
  RbacCatalogPortService,
} from './rbac-catalog-port.service';
import { AuditEmitter, SYSTEM_AUDIT_ACTOR } from '@taste-and-see/nest-audit';

/**
 * In-memory fake of the Prisma surface the port service (and the
 * shared `applyRbacCatalog` core it calls) touches. Same convention as
 * the sibling `seed.test.ts` fake, extended with the reads
 * `exportCatalog` / `planImport` need.
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
  archivedAt: Date | null;
}
interface RolePermissionRow {
  roleId: string;
  permissionId: string;
}

function buildFakeDb(): {
  prisma: PrismaService;
  permissions: Map<string, PermissionRow>;
  roles: Map<string, RoleRow>;
  rolePermissions: RolePermissionRow[];
  addPermission: (resource: string, action: string, description?: string | null) => PermissionRow;
  addRole: (
    name: string,
    opts?: { isSystem?: boolean; description?: string | null; archivedAt?: Date | null },
  ) => RoleRow;
  link: (role: RoleRow, permission: PermissionRow) => void;
  transactionCalls: () => number;
} {
  const permissions = new Map<string, PermissionRow>();
  const roles = new Map<string, RoleRow>();
  const rolePermissions: RolePermissionRow[] = [];
  let pCounter = 0;
  let rCounter = 0;
  let txCalls = 0;

  function addPermission(
    resource: string,
    action: string,
    description: string | null = null,
  ): PermissionRow {
    pCounter += 1;
    const row = { id: `p_${pCounter}`, resource, action, description };
    permissions.set(`${resource}:${action}`, row);
    return row;
  }
  function addRole(
    name: string,
    opts: { isSystem?: boolean; description?: string | null; archivedAt?: Date | null } = {},
  ): RoleRow {
    rCounter += 1;
    const row = {
      id: `r_${rCounter}`,
      name,
      description: opts.description ?? null,
      isSystem: opts.isSystem ?? false,
      archivedAt: opts.archivedAt ?? null,
    };
    roles.set(name, row);
    return row;
  }
  function link(role: RoleRow, permission: PermissionRow): void {
    rolePermissions.push({ roleId: role.id, permissionId: permission.id });
  }

  function roleWithPermissions(row: RoleRow): {
    rolePermissions: Array<{ permission: { resource: string; action: string } }>;
  } & RoleRow {
    const permissionById = new Map([...permissions.values()].map((p) => [p.id, p]));
    return {
      ...row,
      rolePermissions: rolePermissions
        .filter((rp) => rp.roleId === row.id)
        .map((rp) => {
          const p = permissionById.get(rp.permissionId);
          return { permission: { resource: p?.resource ?? '?', action: p?.action ?? '?' } };
        }),
    };
  }

  const surface = {
    permission: {
      findMany: vi.fn(
        async (req?: { where?: { OR: ReadonlyArray<{ resource: string; action: string }> } }) => {
          const all = [...permissions.values()];
          const filtered =
            req?.where?.OR !== undefined
              ? all.filter((p) =>
                  req.where!.OR.some((c) => c.resource === p.resource && c.action === p.action),
                )
              : all;
          return filtered
            .map((p) => ({ ...p }))
            .sort((a, b) => `${a.resource}:${a.action}`.localeCompare(`${b.resource}:${b.action}`));
        },
      ),
      upsert: vi.fn(
        async (req: {
          where: { resource_action: { resource: string; action: string } };
          create: { resource: string; action: string; description: string | null };
          update: { description: string | null };
        }) => {
          const key = `${req.where.resource_action.resource}:${req.where.resource_action.action}`;
          let existing = permissions.get(key);
          if (existing === undefined) {
            existing = addPermission(
              req.create.resource,
              req.create.action,
              req.create.description,
            );
          } else {
            existing.description = req.update.description;
          }
          return { id: existing.id, resource: existing.resource, action: existing.action };
        },
      ),
    },
    role: {
      findMany: vi.fn(async (req?: { where?: { archivedAt: null } }) => {
        const all = [...roles.values()];
        const filtered = req?.where !== undefined ? all.filter((r) => r.archivedAt === null) : all;
        return filtered.map(roleWithPermissions).sort((a, b) => a.name.localeCompare(b.name));
      }),
      findUnique: vi.fn(async (req: { where: { name: string } }) => {
        const row = roles.get(req.where.name);
        return row === undefined ? null : roleWithPermissions(row);
      }),
      upsert: vi.fn(
        async (req: {
          where: { name: string };
          create: { name: string; description: string | null; isSystem: boolean };
          update: { description: string | null; isSystem: boolean };
        }) => {
          let existing = roles.get(req.where.name);
          if (existing === undefined) {
            existing = addRole(req.create.name, {
              description: req.create.description,
              isSystem: req.create.isSystem,
            });
          } else {
            existing.description = req.update.description;
            existing.isSystem = req.update.isSystem;
          }
          return { id: existing.id };
        },
      ),
    },
    rolePermission: {
      findMany: vi.fn(async (req: { where: { roleId: string } }) =>
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
    $transaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
      txCalls += 1;
      return cb(surface);
    }),
  };

  return {
    prisma: surface as unknown as PrismaService,
    permissions,
    roles,
    rolePermissions,
    addPermission,
    addRole,
    link,
    transactionCalls: () => txCalls,
  };
}

function buildFakeEmitter(): {
  emitter: AuditEmitter;
  emits: Array<{
    action: string;
    resourceKind: string;
    resourceId: string;
    before: unknown;
    after: unknown;
  }>;
} {
  const emits: Array<{
    action: string;
    resourceKind: string;
    resourceId: string;
    before: unknown;
    after: unknown;
  }> = [];
  const emitter = {
    emit: vi.fn(
      async (
        _tx: unknown,
        _actor: unknown,
        descriptor: {
          action: string;
          resourceKind: string;
          resourceId: string;
          before: unknown;
          after: unknown;
        },
      ) => {
        emits.push({ ...descriptor });
      },
    ),
  };
  return { emitter: emitter as unknown as AuditEmitter, emits };
}

function envelope(overrides: Partial<RbacCatalogEnvelope> = {}): RbacCatalogEnvelope {
  return {
    formatVersion: RBAC_CATALOG_FORMAT_VERSION,
    exportedAt: '2026-07-02T12:00:00.000Z',
    permissions: [],
    roles: [],
    ...overrides,
  };
}

const NOW = new Date('2026-07-02T12:00:00.000Z');

describe('RbacCatalogPortService.exportCatalog', () => {
  it('projects an id-free envelope with sorted permission strings, excluding archived roles', async () => {
    const db = buildFakeDb();
    const read = db.addPermission('rbac', 'read', 'Read.');
    const write = db.addPermission('rbac', 'write', null);
    const live = db.addRole('custom_ops', { description: 'Ops.' });
    db.link(live, write);
    db.link(live, read);
    db.addRole('old_role', { archivedAt: new Date('2026-01-01T00:00:00Z') });

    const { emitter } = buildFakeEmitter();
    const service = new RbacCatalogPortService(db.prisma, emitter);
    const result = await service.exportCatalog(NOW);

    expect(result.formatVersion).toBe(RBAC_CATALOG_FORMAT_VERSION);
    expect(result.exportedAt).toBe('2026-07-02T12:00:00.000Z');
    expect(result.permissions).toEqual([
      { resource: 'rbac', action: 'read', description: 'Read.' },
      { resource: 'rbac', action: 'write', description: null },
    ]);
    expect(result.roles).toEqual([
      {
        name: 'custom_ops',
        description: 'Ops.',
        isSystem: false,
        permissions: ['rbac:read', 'rbac:write'],
      },
    ]);
  });
});

describe('RbacCatalogPortService.planImport', () => {
  it('detects permission creates, description updates, and role attach/detach diffs', async () => {
    const db = buildFakeDb();
    const read = db.addPermission('rbac', 'read', 'Old copy.');
    const write = db.addPermission('rbac', 'write', 'Write.');
    const role = db.addRole('custom_ops', { description: 'Ops.' });
    db.link(role, read);
    db.link(role, write);

    const { emitter } = buildFakeEmitter();
    const service = new RbacCatalogPortService(db.prisma, emitter);
    const plan = await service.planImport(
      envelope({
        permissions: [
          { resource: 'rbac', action: 'read', description: 'New copy.' },
          { resource: 'widget', action: 'read', description: null },
        ],
        roles: [
          {
            name: 'custom_ops',
            description: 'Ops.',
            isSystem: false,
            permissions: ['rbac:read', 'widget:read'],
          },
        ],
      }),
    );

    expect(plan.errors).toEqual([]);
    expect(plan.permissionsToCreate).toEqual(['widget:read']);
    expect(plan.permissionDescriptionUpdates).toEqual(['rbac:read']);
    expect(plan.roleDiffs).toHaveLength(1);
    expect(plan.roleDiffs[0]).toMatchObject({
      name: 'custom_ops',
      kind: 'update',
      isSystem: false,
      sensitive: false,
      permissionsToAttach: ['widget:read'],
      permissionsToDetach: ['rbac:write'],
    });
    // rbac:write stays on disk — reported as a warning, never deleted.
    expect(plan.warnings.some((w) => w.includes('"rbac:write"'))).toBe(true);
  });

  it('reports unchanged roles and warns about target-only rows', async () => {
    const db = buildFakeDb();
    const read = db.addPermission('audit', 'read', 'Read audit.');
    const role = db.addRole('custom_auditor');
    db.link(role, read);
    db.addRole('target_only_role');

    const { emitter } = buildFakeEmitter();
    const service = new RbacCatalogPortService(db.prisma, emitter);
    const plan = await service.planImport(
      envelope({
        permissions: [{ resource: 'audit', action: 'read', description: 'Read audit.' }],
        roles: [
          {
            name: 'custom_auditor',
            description: null,
            isSystem: false,
            permissions: ['audit:read'],
          },
        ],
      }),
    );

    expect(plan.roleDiffs).toEqual([]);
    expect(plan.unchangedRoles).toEqual(['custom_auditor']);
    expect(plan.warnings.some((w) => w.includes('"target_only_role"'))).toBe(true);
  });

  it('rejects unknown permissions, bogus isSystem claims, reserved names, and archived targets', async () => {
    const db = buildFakeDb();
    db.addRole('parked_role', { archivedAt: new Date('2026-01-01T00:00:00Z') });

    const { emitter } = buildFakeEmitter();
    const service = new RbacCatalogPortService(db.prisma, emitter);
    const plan = await service.planImport(
      envelope({
        roles: [
          { name: 'ghost_role', description: null, isSystem: false, permissions: ['ghost:walk'] },
          { name: 'fake_system', description: null, isSystem: true, permissions: [] },
          { name: 'super_admin', description: null, isSystem: false, permissions: [] },
          { name: 'parked_role', description: 'revive', isSystem: false, permissions: [] },
        ],
      }),
    );

    expect(plan.errors).toHaveLength(4);
    expect(plan.errors.some((e) => e.includes('ghost:walk'))).toBe(true);
    expect(plan.errors.some((e) => e.includes('"fake_system" claims isSystem'))).toBe(true);
    expect(
      plan.errors.some((e) => e.includes('"super_admin" is a reserved system role name')),
    ).toBe(true);
    expect(plan.errors.some((e) => e.includes('"parked_role" is archived'))).toBe(true);
  });

  it('flags changed system roles for the guardrail, marking sensitive ones', async () => {
    const db = buildFakeDb();
    const read = db.addPermission('user', 'read', 'Read users.');
    db.addPermission('user', 'impersonate', 'Impersonate.');
    const superAdmin = db.addRole('super_admin', { isSystem: true });
    db.link(superAdmin, read);

    const { emitter } = buildFakeEmitter();
    const service = new RbacCatalogPortService(db.prisma, emitter);
    const plan = await service.planImport(
      envelope({
        roles: [
          {
            name: 'super_admin',
            description: null,
            isSystem: true,
            permissions: ['user:read', 'user:impersonate'],
          },
        ],
      }),
    );

    expect(plan.errors).toEqual([]);
    expect(plan.systemRoleChanges).toEqual(['super_admin']);
    expect(plan.roleDiffs[0]).toMatchObject({ isSystem: true, sensitive: true });
  });
});

describe('RbacCatalogPortService.applyImport', () => {
  it('throws the validation error before any write', async () => {
    const db = buildFakeDb();
    const { emitter, emits } = buildFakeEmitter();
    const service = new RbacCatalogPortService(db.prisma, emitter);

    await expect(
      service.applyImport(
        envelope({
          roles: [
            { name: 'ghost_role', description: null, isSystem: false, permissions: ['ghost:walk'] },
          ],
        }),
        { allowSystem: false, actor: SYSTEM_AUDIT_ACTOR },
      ),
    ).rejects.toThrowError(RbacCatalogImportValidationError);
    expect(db.transactionCalls()).toBe(0);
    expect(emits).toEqual([]);
  });

  it('refuses system-role changes without allowSystem (exit-2 path), writing nothing', async () => {
    const db = buildFakeDb();
    db.addPermission('user', 'read', 'Read users.');
    db.addRole('super_admin', { isSystem: true });

    const { emitter, emits } = buildFakeEmitter();
    const service = new RbacCatalogPortService(db.prisma, emitter);

    await expect(
      service.applyImport(
        envelope({
          roles: [
            { name: 'super_admin', description: null, isSystem: true, permissions: ['user:read'] },
          ],
        }),
        { allowSystem: false, actor: SYSTEM_AUDIT_ACTOR },
      ),
    ).rejects.toThrowError(RbacCatalogImportRefusedError);
    expect(db.transactionCalls()).toBe(0);
    expect(emits).toEqual([]);
    expect(db.rolePermissions).toEqual([]);
  });

  it('applies changes in one transaction with one audit event per changed role', async () => {
    const db = buildFakeDb();
    const read = db.addPermission('audit', 'read', 'Read audit.');
    const unchanged = db.addRole('steady_role');
    db.link(unchanged, read);

    const { emitter, emits } = buildFakeEmitter();
    const service = new RbacCatalogPortService(db.prisma, emitter);
    const result = await service.applyImport(
      envelope({
        permissions: [
          { resource: 'audit', action: 'read', description: 'Read audit.' },
          { resource: 'widget', action: 'read', description: null },
        ],
        roles: [
          { name: 'steady_role', description: null, isSystem: false, permissions: ['audit:read'] },
          {
            name: 'widget_operator',
            description: 'Operates widgets.',
            isSystem: false,
            permissions: ['widget:read'],
          },
        ],
      }),
      { allowSystem: false, actor: SYSTEM_AUDIT_ACTOR },
    );

    expect(result.applied).toBe(true);
    expect(result.auditedRoles).toEqual(['widget_operator']);
    expect(db.transactionCalls()).toBe(1);
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({
      action: 'rbac_role:create',
      resourceKind: 'rbac_role',
      before: null,
    });
    expect(db.roles.get('widget_operator')?.isSystem).toBe(false);
  });

  it('allows system-role changes with allowSystem, emitting rbac_role:update', async () => {
    const db = buildFakeDb();
    const read = db.addPermission('user', 'read', 'Read users.');
    db.addPermission('user', 'impersonate', 'Impersonate.');
    const superAdmin = db.addRole('super_admin', { isSystem: true });
    db.link(superAdmin, read);

    const { emitter, emits } = buildFakeEmitter();
    const service = new RbacCatalogPortService(db.prisma, emitter);
    const result = await service.applyImport(
      envelope({
        roles: [
          {
            name: 'super_admin',
            description: null,
            isSystem: true,
            permissions: ['user:read', 'user:impersonate'],
          },
        ],
      }),
      { allowSystem: true, actor: SYSTEM_AUDIT_ACTOR },
    );

    expect(result.applied).toBe(true);
    expect(emits).toHaveLength(1);
    expect(emits[0]?.action).toBe('rbac_role:update');
    expect(db.roles.get('super_admin')?.isSystem).toBe(true);
    expect(db.rolePermissions.filter((rp) => rp.roleId === superAdmin.id)).toHaveLength(2);
  });

  it('is a no-op (applied: false, no transaction) when the catalog is already in sync', async () => {
    const db = buildFakeDb();
    const read = db.addPermission('audit', 'read', 'Read audit.');
    const role = db.addRole('steady_role');
    db.link(role, read);

    const { emitter, emits } = buildFakeEmitter();
    const service = new RbacCatalogPortService(db.prisma, emitter);
    const result = await service.applyImport(
      envelope({
        permissions: [{ resource: 'audit', action: 'read', description: 'Read audit.' }],
        roles: [
          { name: 'steady_role', description: null, isSystem: false, permissions: ['audit:read'] },
        ],
      }),
      { allowSystem: false, actor: SYSTEM_AUDIT_ACTOR },
    );

    expect(result.applied).toBe(false);
    expect(result.report).toBeNull();
    expect(db.transactionCalls()).toBe(0);
    expect(emits).toEqual([]);
  });
});
