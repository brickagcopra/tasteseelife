import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { RoleCatalogService } from './role-catalog.service';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { AuditEmitter } from '@taste-and-see/nest-audit';

/** Loose audit-emitter stub — TS-295 emission is asserted in its own suite. */
function fakeAudit(): AuditEmitter {
  return { emit: vi.fn(async () => undefined) } as unknown as AuditEmitter;
}

/** Minimal audit actor context for the admin surface (global scope). */
function actorCtx(actorUserId: string): AuditActorContext {
  return {
    actorUserId,
    actorRole: 'super_admin',
    actorTenantScopeType: 'global',
    actorTenantScopeId: null,
    ip: null,
    userAgent: null,
    requestId: null,
    traceId: null,
  };
}

/**
 * In-memory fake of the slice of Prisma that RoleCatalogService
 * touches: `permissions`, `roles`, and `role_permissions`, plus the
 * `$transaction(callback)` interactive-transaction surface (the fake
 * just runs the callback against itself — atomicity is the DB's job;
 * these tests assert the service's orchestration and error mapping).
 */
interface FakePermissionRow {
  id: string;
  resource: string;
  action: string;
  description: string | null;
}

interface FakeRoleRow {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function buildFakePrisma(seed: {
  permissions?: FakePermissionRow[];
  roles?: FakeRoleRow[];
  /** roleId → permission ids attached. */
  rolePermissions?: Record<string, string[]>;
  /** Fired before `role.create` persists — simulates P2002 etc. */
  onRoleCreate?: () => void;
  /** Fired before `role.update` persists — simulates rename P2002. */
  onRoleUpdate?: () => void;
}): {
  prisma: PrismaService;
  roles: Map<string, FakeRoleRow>;
  rolePermissions: Map<string, Set<string>>;
} {
  const permissions = new Map<string, FakePermissionRow>();
  for (const p of seed.permissions ?? []) permissions.set(p.id, p);
  const roles = new Map<string, FakeRoleRow>();
  for (const r of seed.roles ?? []) roles.set(r.id, r);
  const rolePermissions = new Map<string, Set<string>>();
  for (const [roleId, permIds] of Object.entries(seed.rolePermissions ?? {})) {
    rolePermissions.set(roleId, new Set(permIds));
  }
  let counter = 0;

  function projectRole(row: FakeRoleRow): Record<string, unknown> {
    const attached = rolePermissions.get(row.id) ?? new Set<string>();
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      isSystem: row.isSystem,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      rolePermissions: [...attached]
        .map((pid) => permissions.get(pid))
        .filter((p): p is FakePermissionRow => p !== undefined)
        .map((p) => ({ permission: { resource: p.resource, action: p.action } })),
    };
  }

  const permissionSurface = {
    findMany: vi.fn(
      async (req: {
        where?: { OR?: ReadonlyArray<{ resource: string; action: string }> };
        select?: unknown;
      }) => {
        const all = [...permissions.values()];
        const filtered =
          req.where?.OR !== undefined
            ? all.filter((p) =>
                req.where?.OR?.some((c) => c.resource === p.resource && c.action === p.action),
              )
            : all;
        return filtered
          .sort((a, b) =>
            a.resource === b.resource
              ? a.action.localeCompare(b.action)
              : a.resource.localeCompare(b.resource),
          )
          .map((p) => ({
            id: p.id,
            resource: p.resource,
            action: p.action,
            description: p.description,
          }));
      },
    ),
  };

  const roleSurface = {
    findMany: vi.fn(async (req: { where?: { archivedAt?: null } }) => {
      const all = [...roles.values()].sort((a, b) => a.name.localeCompare(b.name));
      const filtered =
        req.where !== undefined && 'archivedAt' in req.where
          ? all.filter((r) => r.archivedAt === null)
          : all;
      return filtered.map(projectRole);
    }),
    findUnique: vi.fn(async (req: { where: { id?: string } }) => {
      if (req.where.id === undefined) return null;
      const row = roles.get(req.where.id);
      return row === undefined ? null : projectRole(row);
    }),
    findUniqueOrThrow: vi.fn(async (req: { where: { id: string } }) => {
      const row = roles.get(req.where.id);
      if (row === undefined) throw new Error(`fake: role ${req.where.id} missing`);
      return projectRole(row);
    }),
    create: vi.fn(
      async (req: { data: { name: string; description: string | null; isSystem: boolean } }) => {
        seed.onRoleCreate?.();
        for (const r of roles.values()) {
          if (r.name === req.data.name) {
            throw Object.assign(new Error('unique violation'), { code: 'P2002' });
          }
        }
        counter += 1;
        const id = `role_${counter}`;
        const now = new Date();
        roles.set(id, {
          id,
          name: req.data.name,
          description: req.data.description,
          isSystem: req.data.isSystem,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        return { id };
      },
    ),
    update: vi.fn(
      async (req: {
        where: { id: string };
        data: { name?: string; description?: string | null; archivedAt?: Date };
      }) => {
        seed.onRoleUpdate?.();
        const row = roles.get(req.where.id);
        if (row === undefined) throw new Error(`fake: role ${req.where.id} missing`);
        if (req.data.name !== undefined) {
          for (const other of roles.values()) {
            if (other.id !== row.id && other.name === req.data.name) {
              throw Object.assign(new Error('unique violation'), { code: 'P2002' });
            }
          }
          row.name = req.data.name;
        }
        if (req.data.description !== undefined) row.description = req.data.description;
        if (req.data.archivedAt !== undefined) row.archivedAt = req.data.archivedAt;
        row.updatedAt = new Date();
        return projectRole(row);
      },
    ),
  };

  const rolePermissionSurface = {
    createMany: vi.fn(
      async (req: { data: ReadonlyArray<{ roleId: string; permissionId: string }> }) => {
        for (const entry of req.data) {
          const set = rolePermissions.get(entry.roleId) ?? new Set<string>();
          set.add(entry.permissionId);
          rolePermissions.set(entry.roleId, set);
        }
        return { count: req.data.length };
      },
    ),
    deleteMany: vi.fn(async (req: { where: { roleId: string } }) => {
      const set = rolePermissions.get(req.where.roleId);
      const count = set?.size ?? 0;
      rolePermissions.delete(req.where.roleId);
      return { count };
    }),
  };

  const fake = {
    permission: permissionSurface,
    role: roleSurface,
    rolePermission: rolePermissionSurface,
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(fake)),
  };

  return {
    prisma: fake as unknown as PrismaService,
    roles,
    rolePermissions,
  };
}

const CATALOG: FakePermissionRow[] = [
  { id: 'p_user_read', resource: 'user', action: 'read', description: 'View users.' },
  { id: 'p_user_suspend', resource: 'user', action: 'suspend', description: null },
  { id: 'p_rbac_read', resource: 'rbac', action: 'read', description: 'Read RBAC.' },
];

function liveRole(overrides: Partial<FakeRoleRow> = {}): FakeRoleRow {
  const now = new Date('2026-07-01T10:00:00Z');
  return {
    id: 'role_live',
    name: 'regional_ops',
    description: 'Regional ops staff.',
    isSystem: false,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('RoleCatalogService.listPermissions', () => {
  it('returns the catalog ordered by (resource, action)', async () => {
    const { prisma } = buildFakePrisma({ permissions: CATALOG });
    const svc = new RoleCatalogService(prisma, fakeAudit());
    const rows = await svc.listPermissions();
    expect(rows.map((r) => `${r.resource}:${r.action}`)).toEqual([
      'rbac:read',
      'user:read',
      'user:suspend',
    ]);
  });
});

describe('RoleCatalogService.listRoles', () => {
  it('excludes archived roles by default and inlines sorted permission strings', async () => {
    const { prisma } = buildFakePrisma({
      permissions: CATALOG,
      roles: [
        liveRole({ id: 'r1', name: 'b_role' }),
        liveRole({ id: 'r2', name: 'a_archived', archivedAt: new Date() }),
      ],
      rolePermissions: { r1: ['p_user_suspend', 'p_user_read'] },
    });
    const svc = new RoleCatalogService(prisma, fakeAudit());

    const rows = await svc.listRoles();
    expect(rows.map((r) => r.name)).toEqual(['b_role']);
    expect(rows[0]?.permissions).toEqual(['user:read', 'user:suspend']);
  });

  it('includes archived roles when opted in', async () => {
    const { prisma } = buildFakePrisma({
      roles: [
        liveRole({ id: 'r1', name: 'b_role' }),
        liveRole({ id: 'r2', name: 'a_archived', archivedAt: new Date() }),
      ],
    });
    const svc = new RoleCatalogService(prisma, fakeAudit());

    const rows = await svc.listRoles({ includeArchived: true });
    expect(rows.map((r) => r.name)).toEqual(['a_archived', 'b_role']);
  });
});

describe('RoleCatalogService.getRole', () => {
  it('returns null for an unknown id', async () => {
    const { prisma } = buildFakePrisma({});
    const svc = new RoleCatalogService(prisma, fakeAudit());
    expect(await svc.getRole('missing')).toBeNull();
  });

  it('returns archived roles (read is fine)', async () => {
    const { prisma } = buildFakePrisma({
      roles: [liveRole({ id: 'r1', archivedAt: new Date('2026-07-01T11:00:00Z') })],
    });
    const svc = new RoleCatalogService(prisma, fakeAudit());
    const row = await svc.getRole('r1');
    expect(row?.archivedAt).not.toBeNull();
  });
});

describe('RoleCatalogService.createRole', () => {
  it('creates a custom role with resolved permissions and isSystem=false', async () => {
    const { prisma, roles, rolePermissions } = buildFakePrisma({ permissions: CATALOG });
    const svc = new RoleCatalogService(prisma, fakeAudit());

    const row = await svc.createRole({
      name: 'regional_ops',
      description: 'Regional ops staff.',
      permissions: ['user:read', 'rbac:read'],
      actor: actorCtx('admin_1'),
    });

    expect(row.isSystem).toBe(false);
    expect(row.permissions).toEqual(['rbac:read', 'user:read']);
    expect(roles.size).toBe(1);
    expect(rolePermissions.get(row.id)?.size).toBe(2);
  });

  it('accepts an empty permission set', async () => {
    const { prisma } = buildFakePrisma({ permissions: CATALOG });
    const svc = new RoleCatalogService(prisma, fakeAudit());
    const row = await svc.createRole({
      name: 'shell_role',
      permissions: [],
      actor: actorCtx('admin_1'),
    });
    expect(row.permissions).toEqual([]);
  });

  it('rejects unknown permission strings with a 400 naming the offenders', async () => {
    const { prisma, roles } = buildFakePrisma({ permissions: CATALOG });
    const svc = new RoleCatalogService(prisma, fakeAudit());

    const attempt = svc.createRole({
      name: 'regional_ops',
      permissions: ['user:read', 'nope:missing', 'also:absent'],
      actor: actorCtx('admin_1'),
    });
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await attempt.catch((err: BadRequestException) => {
      const body = err.getResponse() as { detail: string; unknownPermissions: string[] };
      expect(body.unknownPermissions).toEqual(['nope:missing', 'also:absent']);
      expect(body.detail).toContain('nope:missing');
    });
    expect(roles.size).toBe(0);
  });

  it('translates a name collision (P2002) into a 409', async () => {
    const { prisma } = buildFakePrisma({
      permissions: CATALOG,
      roles: [liveRole({ id: 'r1', name: 'regional_ops' })],
    });
    const svc = new RoleCatalogService(prisma, fakeAudit());

    await expect(
      svc.createRole({ name: 'regional_ops', permissions: [], actor: actorCtx('admin_1') }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rethrows non-P2002 errors unchanged', async () => {
    const boom = new Error('connection reset');
    const { prisma } = buildFakePrisma({
      permissions: CATALOG,
      onRoleCreate: () => {
        throw boom;
      },
    });
    const svc = new RoleCatalogService(prisma, fakeAudit());
    await expect(
      svc.createRole({ name: 'x_role', permissions: [], actor: actorCtx('admin_1') }),
    ).rejects.toBe(boom);
  });
});

describe('RoleCatalogService.updateRole', () => {
  it('404s on an unknown id', async () => {
    const { prisma } = buildFakePrisma({});
    const svc = new RoleCatalogService(prisma, fakeAudit());
    await expect(
      svc.updateRole({ roleId: 'missing', name: 'x_role', actor: actorCtx('admin_1') }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects mutation of a SYSTEM role with 409 (seed-owned)', async () => {
    const { prisma } = buildFakePrisma({
      roles: [liveRole({ id: 'r1', name: 'super_admin', isSystem: true })],
    });
    const svc = new RoleCatalogService(prisma, fakeAudit());
    await expect(
      svc.updateRole({ roleId: 'r1', description: 'nope', actor: actorCtx('admin_1') }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects mutation of an ARCHIVED role with 409 (read-only)', async () => {
    const { prisma } = buildFakePrisma({
      roles: [liveRole({ id: 'r1', archivedAt: new Date() })],
    });
    const svc = new RoleCatalogService(prisma, fakeAudit());
    await expect(
      svc.updateRole({ roleId: 'r1', name: 'renamed', actor: actorCtx('admin_1') }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('replaces the permission set atomically and leaves omitted fields untouched', async () => {
    const { prisma, rolePermissions } = buildFakePrisma({
      permissions: CATALOG,
      roles: [liveRole({ id: 'r1' })],
      rolePermissions: { r1: ['p_user_read', 'p_user_suspend'] },
    });
    const svc = new RoleCatalogService(prisma, fakeAudit());

    const row = await svc.updateRole({
      roleId: 'r1',
      permissions: ['rbac:read'],
      actor: actorCtx('admin_1'),
    });

    expect(row.permissions).toEqual(['rbac:read']);
    expect(row.name).toBe('regional_ops');
    expect(row.description).toBe('Regional ops staff.');
    expect(rolePermissions.get('r1')?.size).toBe(1);
  });

  it('clears the description on explicit null', async () => {
    const { prisma } = buildFakePrisma({ roles: [liveRole({ id: 'r1' })] });
    const svc = new RoleCatalogService(prisma, fakeAudit());
    const row = await svc.updateRole({
      roleId: 'r1',
      description: null,
      actor: actorCtx('admin_1'),
    });
    expect(row.description).toBeNull();
  });

  it('translates a rename collision (P2002) into a 409', async () => {
    const { prisma } = buildFakePrisma({
      roles: [liveRole({ id: 'r1', name: 'a_role' }), liveRole({ id: 'r2', name: 'b_role' })],
    });
    const svc = new RoleCatalogService(prisma, fakeAudit());
    await expect(
      svc.updateRole({ roleId: 'r1', name: 'b_role', actor: actorCtx('admin_1') }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('RoleCatalogService.archiveRole', () => {
  it('sets archivedAt on a live custom role', async () => {
    const { prisma, roles } = buildFakePrisma({ roles: [liveRole({ id: 'r1' })] });
    const svc = new RoleCatalogService(prisma, fakeAudit());

    const row = await svc.archiveRole({ roleId: 'r1', actor: actorCtx('admin_1') });
    expect(row.archivedAt).not.toBeNull();
    expect(roles.get('r1')?.archivedAt).not.toBeNull();
  });

  it('404s on an unknown id', async () => {
    const { prisma } = buildFakePrisma({});
    const svc = new RoleCatalogService(prisma, fakeAudit());
    await expect(
      svc.archiveRole({ roleId: 'missing', actor: actorCtx('admin_1') }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects archiving a SYSTEM role with 409', async () => {
    const { prisma } = buildFakePrisma({
      roles: [liveRole({ id: 'r1', name: 'finance', isSystem: true })],
    });
    const svc = new RoleCatalogService(prisma, fakeAudit());
    await expect(
      svc.archiveRole({ roleId: 'r1', actor: actorCtx('admin_1') }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects re-archiving with 409 (already archived)', async () => {
    const { prisma } = buildFakePrisma({
      roles: [liveRole({ id: 'r1', archivedAt: new Date() })],
    });
    const svc = new RoleCatalogService(prisma, fakeAudit());
    await expect(
      svc.archiveRole({ roleId: 'r1', actor: actorCtx('admin_1') }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
