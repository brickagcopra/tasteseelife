import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { RoleAssignmentService } from './role-assignment.service';

/**
 * In-memory fake of the slice of Prisma that RoleAssignmentService
 * touches. Models the `roles` and `user_roles` tables and the
 * `role.rolePermissions.permission` join used by `listForUser`.
 *
 * Hand-rolled rather than auto-mocked because the relation traversal
 * (`role.rolePermissions[].permission`) needs a real graph to project
 * the auth-sdk `RoleAssignment.permissions` array correctly.
 */
type DbScopeType = 'global' | 'tenant' | 'household';

interface FakeRoleRow {
  id: string;
  name: string;
  permissions: ReadonlyArray<{ resource: string; action: string }>;
  /** Soft-archive marker (TS-290). Omitted = live role. */
  archivedAt?: Date | null;
}

interface FakeUserRoleRow {
  id: string;
  userId: string;
  roleId: string;
  scopeType: DbScopeType;
  scopeId: string | null;
  grantedByUserId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

function buildFakePrisma(seed: {
  roles: FakeRoleRow[];
  /**
   * Optional hook fired before `userRole.create` persists — lets the
   * P2002 tests (TS-024-followup-3) simulate the DB-boundary unique
   * violation raised by `user_roles_active_unique_idx` without
   * modelling the partial index inside the fake.
   */
  onUserRoleCreate?: () => void;
}): {
  prisma: PrismaService;
  roles: Map<string, FakeRoleRow>;
  userRoles: Map<string, FakeUserRoleRow>;
} {
  const roles = new Map<string, FakeRoleRow>();
  for (const r of seed.roles) roles.set(r.id, r);
  const userRoles = new Map<string, FakeUserRoleRow>();
  let counter = 0;

  const roleSurface = {
    findUnique: vi.fn(async (req: { where: { name?: string } }) => {
      if (req.where.name === undefined) return null;
      for (const r of roles.values())
        if (r.name === req.where.name)
          return { id: r.id, name: r.name, archivedAt: r.archivedAt ?? null };
      return null;
    }),
  };

  const userRoleSurface = {
    create: vi.fn(
      async (req: {
        data: {
          userId: string;
          roleId: string;
          scopeType: DbScopeType;
          scopeId: string | null;
          grantedByUserId: string | null;
          expiresAt: Date | null;
        };
      }) => {
        seed.onUserRoleCreate?.();
        counter += 1;
        const id = `ur_${counter}`;
        const row: FakeUserRoleRow = {
          id,
          userId: req.data.userId,
          roleId: req.data.roleId,
          scopeType: req.data.scopeType,
          scopeId: req.data.scopeId,
          grantedByUserId: req.data.grantedByUserId,
          expiresAt: req.data.expiresAt,
          createdAt: new Date(),
          revokedAt: null,
        };
        userRoles.set(id, row);
        return { id };
      },
    ),
    updateMany: vi.fn(
      async (req: { where: { id: string; revokedAt: null }; data: { revokedAt: Date } }) => {
        const row = userRoles.get(req.where.id);
        if (row === undefined || row.revokedAt !== null) return { count: 0 };
        row.revokedAt = req.data.revokedAt;
        return { count: 1 };
      },
    ),
    findFirst: vi.fn(
      async (req: {
        where: {
          userId: string;
          revokedAt?: null;
          OR?: ReadonlyArray<{ expiresAt: null } | { expiresAt: { gt: Date } }>;
          role?: { name?: { in?: readonly string[] } };
        };
      }) => {
        for (const r of userRoles.values()) {
          if (r.userId !== req.where.userId) continue;
          if (req.where.revokedAt === null && r.revokedAt !== null) continue;
          if (req.where.OR !== undefined) {
            const passes = req.where.OR.some((c) => {
              if ('expiresAt' in c && c.expiresAt === null) return r.expiresAt === null;
              if (
                'expiresAt' in c &&
                typeof c.expiresAt === 'object' &&
                c.expiresAt !== null &&
                'gt' in c.expiresAt
              ) {
                return r.expiresAt !== null && r.expiresAt.getTime() > c.expiresAt.gt.getTime();
              }
              return false;
            });
            if (!passes) continue;
          }
          const role = roles.get(r.roleId);
          if (role === undefined) continue;
          const nameFilter = req.where.role?.name?.in;
          if (nameFilter !== undefined && !nameFilter.includes(role.name)) continue;
          return { id: r.id };
        }
        return null;
      },
    ),
    findMany: vi.fn(
      async (req: {
        where: {
          userId: string;
          revokedAt?: null;
          OR?: ReadonlyArray<{ expiresAt: null } | { expiresAt: { gt: Date } }>;
        };
        orderBy?: { createdAt: 'asc' | 'desc' };
      }) => {
        const out = [...userRoles.values()].filter((r) => {
          if (r.userId !== req.where.userId) return false;
          if (req.where.revokedAt === null && r.revokedAt !== null) return false;
          if (req.where.OR !== undefined) {
            const passes = req.where.OR.some((c) => {
              if ('expiresAt' in c && c.expiresAt === null) return r.expiresAt === null;
              if (
                'expiresAt' in c &&
                typeof c.expiresAt === 'object' &&
                c.expiresAt !== null &&
                'gt' in c.expiresAt
              ) {
                return r.expiresAt !== null && r.expiresAt.getTime() > c.expiresAt.gt.getTime();
              }
              return false;
            });
            if (!passes) return false;
          }
          return true;
        });
        out.sort((a, b) =>
          req.orderBy?.createdAt === 'desc'
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return out.map((r) => {
          const role = roles.get(r.roleId);
          if (role === undefined) throw new Error(`fake: missing role ${r.roleId}`);
          return {
            id: r.id,
            userId: r.userId,
            scopeType: r.scopeType,
            scopeId: r.scopeId,
            grantedByUserId: r.grantedByUserId,
            createdAt: r.createdAt,
            expiresAt: r.expiresAt,
            revokedAt: r.revokedAt,
            role: {
              name: role.name,
              rolePermissions: role.permissions.map((p) => ({
                permission: { resource: p.resource, action: p.action },
              })),
            },
          };
        });
      },
    ),
  };

  return {
    prisma: {
      role: roleSurface,
      userRole: userRoleSurface,
    } as unknown as PrismaService,
    roles,
    userRoles,
  };
}

describe('RoleAssignmentService.grant', () => {
  it('persists a row with the resolved roleId and the supplied scope/grantor/expiry', async () => {
    const { prisma, userRoles } = buildFakePrisma({
      roles: [{ id: 'r_finance', name: 'finance', permissions: [] }],
    });
    const svc = new RoleAssignmentService(prisma);

    const expiresAt = new Date('2026-12-31T00:00:00.000Z');
    const result = await svc.grant({
      userId: 'u_alice',
      roleName: 'finance',
      scope: { type: 'global' },
      grantedByUserId: 'u_admin',
      expiresAt,
    });

    expect(result.id).toMatch(/^ur_\d+$/);
    expect(userRoles.size).toBe(1);
    const row = [...userRoles.values()][0];
    expect(row?.userId).toBe('u_alice');
    expect(row?.roleId).toBe('r_finance');
    expect(row?.scopeType).toBe('global');
    expect(row?.scopeId).toBeNull();
    expect(row?.grantedByUserId).toBe('u_admin');
    expect(row?.expiresAt?.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(row?.revokedAt).toBeNull();
  });

  it('encodes tenant scope into (scope_type, scope_id) correctly', async () => {
    const { prisma, userRoles } = buildFakePrisma({
      roles: [{ id: 'r_partner_admin', name: 'partner_admin', permissions: [] }],
    });
    const svc = new RoleAssignmentService(prisma);

    await svc.grant({
      userId: 'u_p',
      roleName: 'partner_admin',
      scope: { type: 'tenant', tenantId: 'partner_xyz' },
    });
    const row = [...userRoles.values()][0];
    expect(row?.scopeType).toBe('tenant');
    expect(row?.scopeId).toBe('partner_xyz');
  });

  it('encodes household scope into (scope_type, scope_id) correctly', async () => {
    const { prisma, userRoles } = buildFakePrisma({
      roles: [{ id: 'r_observer', name: 'family_observer', permissions: [] }],
    });
    const svc = new RoleAssignmentService(prisma);

    await svc.grant({
      userId: 'u_o',
      roleName: 'family_observer',
      scope: { type: 'household', householdId: 'hh_123' },
    });
    const row = [...userRoles.values()][0];
    expect(row?.scopeType).toBe('household');
    expect(row?.scopeId).toBe('hh_123');
  });

  it('throws NotFound when the role does not exist', async () => {
    const { prisma } = buildFakePrisma({ roles: [] });
    const svc = new RoleAssignmentService(prisma);
    await expect(
      svc.grant({ userId: 'u', roleName: 'missing', scope: { type: 'global' } }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 409 Conflict when the role is archived (TS-290 — hidden from assignment surfaces)', async () => {
    const { prisma, userRoles } = buildFakePrisma({
      roles: [
        {
          id: 'r1',
          name: 'regional_ops',
          permissions: [],
          archivedAt: new Date('2026-07-01T00:00:00Z'),
        },
      ],
    });
    const svc = new RoleAssignmentService(prisma);
    await expect(
      svc.grant({ userId: 'u', roleName: 'regional_ops', scope: { type: 'global' } }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(userRoles.size).toBe(0);
  });

  it('rejects empty tenantId / householdId at the boundary (BadRequest)', async () => {
    const { prisma } = buildFakePrisma({
      roles: [
        { id: 'r1', name: 'partner_admin', permissions: [] },
        { id: 'r2', name: 'family_observer', permissions: [] },
      ],
    });
    const svc = new RoleAssignmentService(prisma);

    await expect(
      svc.grant({
        userId: 'u',
        roleName: 'partner_admin',
        scope: { type: 'tenant', tenantId: '' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      svc.grant({
        userId: 'u',
        roleName: 'family_observer',
        scope: { type: 'household', householdId: '' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('RoleAssignmentService.grant — duplicate-active dedup (TS-024-followup-3)', () => {
  /**
   * Prisma raises P2002 when `user_roles_active_unique_idx` (the
   * partial unique index; raw-SQL migration) rejects a duplicate
   * ACTIVE (user, role, scope) grant. The service owns translating
   * that into a client-facing 409.
   */
  const p2002 = () =>
    Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: ['user_roles_active_unique_idx'] },
    });

  it('translates P2002 from the active-unique index into a 409 ConflictException', async () => {
    const { prisma } = buildFakePrisma({
      roles: [{ id: 'r_finance', name: 'finance', permissions: [] }],
      onUserRoleCreate: () => {
        throw p2002();
      },
    });
    const svc = new RoleAssignmentService(prisma);

    await expect(
      svc.grant({ userId: 'u', roleName: 'finance', scope: { type: 'global' } }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('carries an RFC 7807 body naming the role but not the constraint internals', async () => {
    const { prisma } = buildFakePrisma({
      roles: [{ id: 'r_finance', name: 'finance', permissions: [] }],
      onUserRoleCreate: () => {
        throw p2002();
      },
    });
    const svc = new RoleAssignmentService(prisma);

    try {
      await svc.grant({ userId: 'u', roleName: 'finance', scope: { type: 'global' } });
      expect.unreachable('grant should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException);
      const body = (err as ConflictException).getResponse();
      expect(body).toMatchObject({ status: 409, title: 'Conflict' });
      const text = JSON.stringify(body);
      expect(text).toContain('finance');
      expect(text).not.toContain('user_roles_active_unique_idx');
    }
  });

  it('rethrows non-P2002 errors unchanged', async () => {
    const connectionError = Object.assign(new Error('Connection refused'), { code: 'P1001' });
    const { prisma } = buildFakePrisma({
      roles: [{ id: 'r_finance', name: 'finance', permissions: [] }],
      onUserRoleCreate: () => {
        throw connectionError;
      },
    });
    const svc = new RoleAssignmentService(prisma);

    await expect(
      svc.grant({ userId: 'u', roleName: 'finance', scope: { type: 'global' } }),
    ).rejects.toBe(connectionError);
  });
});

describe('RoleAssignmentService.revoke', () => {
  it('flips revokedAt on a previously-active row and returns revoked=true', async () => {
    const { prisma, userRoles } = buildFakePrisma({
      roles: [{ id: 'r1', name: 'finance', permissions: [] }],
    });
    const svc = new RoleAssignmentService(prisma);
    const { id } = await svc.grant({ userId: 'u', roleName: 'finance', scope: { type: 'global' } });

    const result = await svc.revoke({ assignmentId: id });
    expect(result.revoked).toBe(true);
    expect(userRoles.get(id)?.revokedAt).toBeInstanceOf(Date);
  });

  it('is idempotent — re-revoking returns revoked=false', async () => {
    const { prisma } = buildFakePrisma({
      roles: [{ id: 'r1', name: 'finance', permissions: [] }],
    });
    const svc = new RoleAssignmentService(prisma);
    const { id } = await svc.grant({ userId: 'u', roleName: 'finance', scope: { type: 'global' } });

    await svc.revoke({ assignmentId: id });
    const second = await svc.revoke({ assignmentId: id });
    expect(second.revoked).toBe(false);
  });

  it('returns revoked=false for an unknown assignment id', async () => {
    const { prisma } = buildFakePrisma({ roles: [] });
    const svc = new RoleAssignmentService(prisma);
    const result = await svc.revoke({ assignmentId: 'ur_does_not_exist' });
    expect(result.revoked).toBe(false);
  });
});

describe('RoleAssignmentService.listForUser / getActiveAssignments', () => {
  it('projects rows into the auth-sdk shape with denormalised permissions', async () => {
    const { prisma } = buildFakePrisma({
      roles: [
        {
          id: 'r_finance',
          name: 'finance',
          permissions: [
            { resource: 'accounting', action: 'close_period' },
            { resource: 'finance', action: 'adjust' },
          ],
        },
      ],
    });
    const svc = new RoleAssignmentService(prisma);
    await svc.grant({ userId: 'u', roleName: 'finance', scope: { type: 'global' } });

    const records = await svc.listForUser('u');
    expect(records).toHaveLength(1);
    expect(records[0]?.assignment).toEqual({
      name: 'finance',
      scope: { type: 'global' },
      permissions: ['accounting:close_period', 'finance:adjust'],
    });
    expect(records[0]?.active).toBe(true);
    expect(records[0]?.revokedAt).toBeNull();
  });

  it('decodes tenant / household scope round-trip', async () => {
    const { prisma } = buildFakePrisma({
      roles: [
        { id: 'r_pa', name: 'partner_admin', permissions: [] },
        { id: 'r_fo', name: 'family_observer', permissions: [] },
      ],
    });
    const svc = new RoleAssignmentService(prisma);
    await svc.grant({
      userId: 'u',
      roleName: 'partner_admin',
      scope: { type: 'tenant', tenantId: 't_1' },
    });
    await svc.grant({
      userId: 'u',
      roleName: 'family_observer',
      scope: { type: 'household', householdId: 'h_1' },
    });

    const list = await svc.listForUser('u');
    const scopes = list.map((r) => r.assignment.scope);
    expect(scopes).toEqual([
      { type: 'tenant', tenantId: 't_1' },
      { type: 'household', householdId: 'h_1' },
    ]);
  });

  it('emits expiresAt as an ISO string when the row has one', async () => {
    const { prisma } = buildFakePrisma({
      roles: [{ id: 'r1', name: 'finance', permissions: [] }],
    });
    const svc = new RoleAssignmentService(prisma);
    const exp = new Date('2026-12-31T00:00:00.000Z');
    await svc.grant({
      userId: 'u',
      roleName: 'finance',
      scope: { type: 'global' },
      expiresAt: exp,
    });
    const records = await svc.listForUser('u');
    expect(records[0]?.assignment.expiresAt).toBe('2026-12-31T00:00:00.000Z');
  });

  it('omits expiresAt from the projection when the row has none', async () => {
    const { prisma } = buildFakePrisma({
      roles: [{ id: 'r1', name: 'finance', permissions: [] }],
    });
    const svc = new RoleAssignmentService(prisma);
    await svc.grant({ userId: 'u', roleName: 'finance', scope: { type: 'global' } });
    const records = await svc.listForUser('u');
    expect(records[0]?.assignment).not.toHaveProperty('expiresAt');
  });

  it('filters out revoked + expired rows from getActiveAssignments', async () => {
    const { prisma, userRoles } = buildFakePrisma({
      roles: [
        { id: 'r_active', name: 'finance', permissions: [] },
        { id: 'r_revoked', name: 'super_admin', permissions: [] },
        { id: 'r_expired', name: 'marketing', permissions: [] },
      ],
    });
    const svc = new RoleAssignmentService(prisma);
    const { id: activeId } = await svc.grant({
      userId: 'u',
      roleName: 'finance',
      scope: { type: 'global' },
    });
    const { id: revokedId } = await svc.grant({
      userId: 'u',
      roleName: 'super_admin',
      scope: { type: 'global' },
    });
    await svc.grant({
      userId: 'u',
      roleName: 'marketing',
      scope: { type: 'global' },
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await svc.revoke({ assignmentId: revokedId });

    const now = new Date('2026-05-09T12:00:00.000Z');
    const activeOnly = await svc.getActiveAssignments('u', now);
    const names = activeOnly.map((a) => a.name);
    expect(names).toEqual(['finance']);
    void activeId;
    expect(userRoles.size).toBe(3); // all three rows still on disk
  });

  it('listForUser({includeInactive: true}) surfaces revoked + expired rows', async () => {
    const { prisma } = buildFakePrisma({
      roles: [
        { id: 'r1', name: 'finance', permissions: [] },
        { id: 'r2', name: 'marketing', permissions: [] },
      ],
    });
    const svc = new RoleAssignmentService(prisma);
    await svc.grant({ userId: 'u', roleName: 'finance', scope: { type: 'global' } });
    await svc.grant({
      userId: 'u',
      roleName: 'marketing',
      scope: { type: 'global' },
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const all = await svc.listForUser('u', {
      now: new Date('2026-05-09T12:00:00.000Z'),
      includeInactive: true,
    });
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.assignment.name === 'marketing')?.active).toBe(false);
    expect(all.find((r) => r.assignment.name === 'finance')?.active).toBe(true);
  });
});

describe('RoleAssignmentService.holdsAnyRole (TS-023-followup-1)', () => {
  it('returns false on an empty roleNames list without hitting the database', async () => {
    const { prisma } = buildFakePrisma({
      roles: [{ id: 'r1', name: 'finance', permissions: [] }],
    });
    const svc = new RoleAssignmentService(prisma);
    const userRoleSurface = (
      prisma as unknown as { userRole: { findFirst: { mock: { calls: unknown[] } } } }
    ).userRole;

    const result = await svc.holdsAnyRole('u', []);
    expect(result).toBe(false);
    expect(userRoleSurface.findFirst.mock.calls).toHaveLength(0);
  });

  it('returns false when the user holds no matching active role', async () => {
    const { prisma } = buildFakePrisma({
      roles: [
        { id: 'r_fp', name: 'family_payer', permissions: [] },
        { id: 'r_finance', name: 'finance', permissions: [] },
      ],
    });
    const svc = new RoleAssignmentService(prisma);
    await svc.grant({ userId: 'u', roleName: 'family_payer', scope: { type: 'global' } });

    const result = await svc.holdsAnyRole('u', ['finance', 'super_admin']);
    expect(result).toBe(false);
  });

  it('returns true when the user holds an active matching role', async () => {
    const { prisma } = buildFakePrisma({
      roles: [{ id: 'r_finance', name: 'finance', permissions: [] }],
    });
    const svc = new RoleAssignmentService(prisma);
    await svc.grant({ userId: 'u', roleName: 'finance', scope: { type: 'global' } });

    const result = await svc.holdsAnyRole('u', ['finance', 'super_admin']);
    expect(result).toBe(true);
  });

  it('treats revoked rows as not held', async () => {
    const { prisma } = buildFakePrisma({
      roles: [{ id: 'r_finance', name: 'finance', permissions: [] }],
    });
    const svc = new RoleAssignmentService(prisma);
    const { id } = await svc.grant({
      userId: 'u',
      roleName: 'finance',
      scope: { type: 'global' },
    });
    await svc.revoke({ assignmentId: id });

    const result = await svc.holdsAnyRole('u', ['finance']);
    expect(result).toBe(false);
  });

  it('treats expired rows as not held', async () => {
    const { prisma } = buildFakePrisma({
      roles: [{ id: 'r_finance', name: 'finance', permissions: [] }],
    });
    const svc = new RoleAssignmentService(prisma);
    await svc.grant({
      userId: 'u',
      roleName: 'finance',
      scope: { type: 'global' },
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const result = await svc.holdsAnyRole('u', ['finance'], new Date('2026-05-09T12:00:00.000Z'));
    expect(result).toBe(false);
  });

  it('returns true when at least one of several roles is held', async () => {
    const { prisma } = buildFakePrisma({
      roles: [
        { id: 'r_marketing', name: 'marketing', permissions: [] },
        { id: 'r_finance', name: 'finance', permissions: [] },
      ],
    });
    const svc = new RoleAssignmentService(prisma);
    await svc.grant({ userId: 'u', roleName: 'marketing', scope: { type: 'global' } });

    const result = await svc.holdsAnyRole('u', ['finance', 'marketing']);
    expect(result).toBe(true);
  });

  it('isolates per-user — a role held by another user does not leak', async () => {
    const { prisma } = buildFakePrisma({
      roles: [{ id: 'r_finance', name: 'finance', permissions: [] }],
    });
    const svc = new RoleAssignmentService(prisma);
    await svc.grant({ userId: 'u_other', roleName: 'finance', scope: { type: 'global' } });

    const result = await svc.holdsAnyRole('u_self', ['finance']);
    expect(result).toBe(false);
  });
});
