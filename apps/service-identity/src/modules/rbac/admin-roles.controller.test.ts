import 'reflect-metadata';

import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { REQUIRE_PERMISSIONS_METADATA_KEY } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';

import { AdminRolesController } from './admin-roles.controller';
import type { RoleCatalogRow, RoleCatalogService } from './role-catalog.service';

const NOW = new Date('2026-07-01T12:00:00.000Z');

function catalogRow(overrides: Partial<RoleCatalogRow> = {}): RoleCatalogRow {
  return {
    id: 'role_1',
    name: 'regional_ops',
    description: 'Regional ops staff.',
    isSystem: false,
    archivedAt: null,
    permissions: ['user:read'],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildService(
  overrides: Partial<{
    listPermissions: RoleCatalogService['listPermissions'];
    listRoles: RoleCatalogService['listRoles'];
    getRole: RoleCatalogService['getRole'];
    createRole: RoleCatalogService['createRole'];
    updateRole: RoleCatalogService['updateRole'];
    archiveRole: RoleCatalogService['archiveRole'];
  }> = {},
): RoleCatalogService {
  return {
    listPermissions:
      overrides.listPermissions ??
      (vi.fn(async () => []) as unknown as RoleCatalogService['listPermissions']),
    listRoles:
      overrides.listRoles ?? (vi.fn(async () => []) as unknown as RoleCatalogService['listRoles']),
    getRole:
      overrides.getRole ?? (vi.fn(async () => null) as unknown as RoleCatalogService['getRole']),
    createRole:
      overrides.createRole ??
      (vi.fn(async () => catalogRow()) as unknown as RoleCatalogService['createRole']),
    updateRole:
      overrides.updateRole ??
      (vi.fn(async () => catalogRow()) as unknown as RoleCatalogService['updateRole']),
    archiveRole:
      overrides.archiveRole ??
      (vi.fn(async () => catalogRow()) as unknown as RoleCatalogService['archiveRole']),
  } as unknown as RoleCatalogService;
}

function actorRequest(userId = 'admin_1'): RequestWithContext {
  return {
    requestContext: {
      userId,
      roles: [
        {
          name: 'super_admin',
          permissions: ['rbac:read', 'rbac:write'],
          scope: { type: 'global' },
        },
      ],
      tenantScope: { type: 'global' },
      sessionId: 'sess_1',
    },
    // The audit actor builder (TS-295) reads request metadata.
    ip: '203.0.113.9',
    headers: {},
  } as unknown as RequestWithContext;
}

describe('AdminRolesController reads', () => {
  it('maps the permission catalog onto the wire DTO', async () => {
    const controller = new AdminRolesController(
      buildService({
        listPermissions: vi.fn(async () => [
          { id: 'p1', resource: 'user', action: 'read', description: 'View users.' },
          { id: 'p2', resource: 'rbac', action: 'write', description: null },
        ]) as unknown as RoleCatalogService['listPermissions'],
      }),
    );

    const response = await controller.listPermissions();
    expect(response.permissions).toHaveLength(2);
    expect(response.permissions[0]).toEqual({
      id: 'p1',
      resource: 'user',
      action: 'read',
      description: 'View users.',
    });
  });

  it('projects role rows with ISO timestamps and inline permissions', async () => {
    const controller = new AdminRolesController(
      buildService({
        listRoles: vi.fn(async () => [
          catalogRow({ archivedAt: NOW }),
        ]) as unknown as RoleCatalogService['listRoles'],
      }),
    );

    const response = await controller.listRoles({});
    expect(response.roles[0]?.createdAt).toBe(NOW.toISOString());
    expect(response.roles[0]?.archivedAt).toBe(NOW.toISOString());
    expect(response.roles[0]?.permissions).toEqual(['user:read']);
  });

  it('forwards includeArchived to the service', async () => {
    const listRoles = vi.fn(async () => []);
    const controller = new AdminRolesController(
      buildService({ listRoles: listRoles as unknown as RoleCatalogService['listRoles'] }),
    );

    await controller.listRoles({ includeArchived: true });
    expect(listRoles).toHaveBeenCalledWith({ includeArchived: true });
  });

  it('404s role detail for an unknown id', async () => {
    const controller = new AdminRolesController(buildService());
    await expect(controller.getRole('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s role detail for an oversized id without hitting the service', async () => {
    const getRole = vi.fn(async () => null);
    const controller = new AdminRolesController(
      buildService({ getRole: getRole as unknown as RoleCatalogService['getRole'] }),
    );
    await expect(controller.getRole('x'.repeat(65))).rejects.toBeInstanceOf(NotFoundException);
    expect(getRole).not.toHaveBeenCalled();
  });
});

describe('AdminRolesController mutations', () => {
  it('passes the actor from the request context into createRole', async () => {
    const createRole = vi.fn(async () => catalogRow());
    const controller = new AdminRolesController(
      buildService({ createRole: createRole as unknown as RoleCatalogService['createRole'] }),
    );

    const response = await controller.createRole(
      { name: 'regional_ops', permissions: ['user:read'] },
      actorRequest('admin_9'),
    );

    expect(createRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ actorUserId: 'admin_9' }),
        name: 'regional_ops',
      }),
    );
    expect(response.role.name).toBe('regional_ops');
  });

  it('401s a mutation without a request context (defence in depth)', async () => {
    const controller = new AdminRolesController(buildService());
    await expect(
      controller.createRole({ name: 'regional_ops', permissions: [] }, {} as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('threads a description clear (null) through the update path', async () => {
    const updateRole = vi.fn(async () => catalogRow({ description: null }));
    const controller = new AdminRolesController(
      buildService({ updateRole: updateRole as unknown as RoleCatalogService['updateRole'] }),
    );

    const response = await controller.updateRole('role_1', { description: null }, actorRequest());

    expect(updateRole).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: 'role_1', description: null }),
    );
    expect(response.role.description).toBeNull();
  });

  it('archive returns the archived role envelope', async () => {
    const controller = new AdminRolesController(
      buildService({
        archiveRole: vi.fn(async () =>
          catalogRow({ archivedAt: NOW }),
        ) as unknown as RoleCatalogService['archiveRole'],
      }),
    );

    const response = await controller.archiveRole('role_1', {}, actorRequest());
    expect(response.role.archivedAt).toBe(NOW.toISOString());
  });
});

describe('AdminRolesController permission gating (TS-290)', () => {
  function requiredPermissions(handler: object): unknown {
    return Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, handler);
  }

  it('gates reads on rbac:read', () => {
    expect(
      requiredPermissions(AdminRolesController.prototype.listPermissions as unknown as object),
    ).toEqual(['rbac:read']);
    expect(
      requiredPermissions(AdminRolesController.prototype.listRoles as unknown as object),
    ).toEqual(['rbac:read']);
    expect(
      requiredPermissions(AdminRolesController.prototype.getRole as unknown as object),
    ).toEqual(['rbac:read']);
  });

  it('gates mutations on rbac:write', () => {
    expect(
      requiredPermissions(AdminRolesController.prototype.createRole as unknown as object),
    ).toEqual(['rbac:write']);
    expect(
      requiredPermissions(AdminRolesController.prototype.updateRole as unknown as object),
    ).toEqual(['rbac:write']);
    expect(
      requiredPermissions(AdminRolesController.prototype.archiveRole as unknown as object),
    ).toEqual(['rbac:write']);
  });
});

describe('AdminRolesController idempotency wiring', () => {
  it('marks every mutation as @Idempotent()', () => {
    for (const handler of [
      AdminRolesController.prototype.createRole,
      AdminRolesController.prototype.updateRole,
      AdminRolesController.prototype.archiveRole,
    ]) {
      const flag = Reflect.getMetadata(
        IDEMPOTENT_METADATA,
        handler as unknown as object,
      ) as unknown;
      expect(flag).toBe(true);
    }
  });

  it('does NOT mark the reads as @Idempotent()', () => {
    for (const handler of [
      AdminRolesController.prototype.listPermissions,
      AdminRolesController.prototype.listRoles,
      AdminRolesController.prototype.getRole,
    ]) {
      const flag = Reflect.getMetadata(
        IDEMPOTENT_METADATA,
        handler as unknown as object,
      ) as unknown;
      expect(flag).toBeUndefined();
    }
  });
});
