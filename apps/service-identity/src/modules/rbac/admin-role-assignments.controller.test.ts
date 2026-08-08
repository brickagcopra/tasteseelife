import 'reflect-metadata';

import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { AdminRoleAssignmentRecord } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { REQUIRE_PERMISSIONS_METADATA_KEY } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';

import { AdminRoleAssignmentsController } from './admin-role-assignments.controller';
import type { RoleAssignmentAdminService } from './role-assignment-admin.service';

const NOW_ISO = '2026-07-01T12:00:00.000Z';

function wireRecord(overrides: Partial<AdminRoleAssignmentRecord> = {}): AdminRoleAssignmentRecord {
  return {
    id: 'ur_1',
    userId: 'user_1',
    roleName: 'customer_support',
    scope: { type: 'global' },
    active: true,
    grantedByUserId: 'admin_1',
    expiresAt: null,
    revokedAt: null,
    createdAt: NOW_ISO,
    ...overrides,
  };
}

function buildService(
  overrides: Partial<{
    listForUser: RoleAssignmentAdminService['listForUser'];
    grantSingle: RoleAssignmentAdminService['grantSingle'];
    revoke: RoleAssignmentAdminService['revoke'];
    bulkPreview: RoleAssignmentAdminService['bulkPreview'];
    bulkCommit: RoleAssignmentAdminService['bulkCommit'];
  }> = {},
): RoleAssignmentAdminService {
  return {
    listForUser:
      overrides.listForUser ??
      (vi.fn(async () => []) as unknown as RoleAssignmentAdminService['listForUser']),
    grantSingle:
      overrides.grantSingle ??
      (vi.fn(async () => wireRecord()) as unknown as RoleAssignmentAdminService['grantSingle']),
    revoke:
      overrides.revoke ??
      (vi.fn(async () => ({ revoked: true })) as unknown as RoleAssignmentAdminService['revoke']),
    bulkPreview:
      overrides.bulkPreview ??
      (vi.fn(async () => []) as unknown as RoleAssignmentAdminService['bulkPreview']),
    bulkCommit:
      overrides.bulkCommit ??
      (vi.fn(async () => []) as unknown as RoleAssignmentAdminService['bulkCommit']),
  } as unknown as RoleAssignmentAdminService;
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

describe('AdminRoleAssignmentsController', () => {
  it('lists a user assignments through the contract envelope', async () => {
    const listForUser = vi.fn(async () => [wireRecord()]);
    const controller = new AdminRoleAssignmentsController(
      buildService({
        listForUser: listForUser as unknown as RoleAssignmentAdminService['listForUser'],
      }),
    );

    const response = await controller.listForUser('user_1', { includeInactive: true });
    expect(listForUser).toHaveBeenCalledWith('user_1', { includeInactive: true });
    expect(response.assignments).toEqual([wireRecord()]);
  });

  it('404s an oversized userId without hitting the service', async () => {
    const listForUser = vi.fn(async () => []);
    const controller = new AdminRoleAssignmentsController(
      buildService({
        listForUser: listForUser as unknown as RoleAssignmentAdminService['listForUser'],
      }),
    );

    await expect(controller.listForUser('x'.repeat(65), {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(listForUser).not.toHaveBeenCalled();
  });

  it('grants with the actor from the request context', async () => {
    const grantSingle = vi.fn(async () => wireRecord());
    const controller = new AdminRoleAssignmentsController(
      buildService({
        grantSingle: grantSingle as unknown as RoleAssignmentAdminService['grantSingle'],
      }),
    );

    const response = await controller.grant(
      {
        userId: 'user_1',
        roleName: 'customer_support',
        scope: { type: 'global' },
      },
      actorRequest('admin_9'),
    );

    expect(grantSingle).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ actorUserId: 'admin_9' }),
      }),
    );
    expect(response.assignment.id).toBe('ur_1');
  });

  it('401s a grant without a request context', async () => {
    const controller = new AdminRoleAssignmentsController(buildService());
    await expect(
      controller.grant(
        { userId: 'user_1', roleName: 'customer_support', scope: { type: 'global' } },
        {} as RequestWithContext,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokes by id and returns the idempotent flag', async () => {
    const revoke = vi.fn(async () => ({ revoked: false }));
    const controller = new AdminRoleAssignmentsController(
      buildService({ revoke: revoke as unknown as RoleAssignmentAdminService['revoke'] }),
    );

    const response = await controller.revoke('ur_1', {}, actorRequest());
    expect(revoke).toHaveBeenCalledWith({
      assignmentId: 'ur_1',
      actor: expect.objectContaining({ actorUserId: 'admin_1' }),
    });
    expect(response).toEqual({ revoked: false });
  });

  it('computes preview counts from the verdicts', async () => {
    const controller = new AdminRoleAssignmentsController(
      buildService({
        bulkPreview: vi.fn(async () => [
          {
            index: 0,
            ok: true,
            errors: [],
            normalized: {
              userId: 'user_1',
              roleName: 'customer_support',
              scope: { type: 'global' },
              expiresAt: null,
            },
          },
          {
            index: 1,
            ok: false,
            errors: [{ field: 'roleName', message: 'no role with this name' }],
            normalized: null,
          },
        ]) as unknown as RoleAssignmentAdminService['bulkPreview'],
      }),
    );

    const response = await controller.bulkPreview({
      rows: [
        {
          userId: 'user_1',
          roleName: 'customer_support',
          scopeType: 'global',
          scopeId: null,
          expiresAt: null,
        },
        {
          userId: 'user_1',
          roleName: 'ghost',
          scopeType: 'global',
          scopeId: null,
          expiresAt: null,
        },
      ],
    });
    expect(response.okCount).toBe(1);
    expect(response.errorCount).toBe(1);
  });

  it('computes commit counts from the outcomes', async () => {
    const controller = new AdminRoleAssignmentsController(
      buildService({
        bulkCommit: vi.fn(async () => [
          { index: 0, status: 'granted', assignmentId: 'ur_1', message: null },
          { index: 1, status: 'conflict', assignmentId: null, message: 'dup' },
          { index: 2, status: 'error', assignmentId: null, message: 'bad' },
        ]) as unknown as RoleAssignmentAdminService['bulkCommit'],
      }),
    );

    const response = await controller.bulkCommit(
      {
        rows: [
          { userId: 'u1', roleName: 'r', scopeType: 'global', scopeId: null, expiresAt: null },
          { userId: 'u2', roleName: 'r', scopeType: 'global', scopeId: null, expiresAt: null },
          { userId: 'u3', roleName: 'r', scopeType: 'global', scopeId: null, expiresAt: null },
        ],
      },
      actorRequest(),
    );
    expect(response.grantedCount).toBe(1);
    expect(response.conflictCount).toBe(1);
    expect(response.errorCount).toBe(1);
  });
});

describe('AdminRoleAssignmentsController permission gating (TS-292)', () => {
  function requiredPermissions(handler: object): unknown {
    return Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, handler);
  }

  it('gates the list and bulk-preview on rbac:read', () => {
    expect(
      requiredPermissions(
        AdminRoleAssignmentsController.prototype.listForUser as unknown as object,
      ),
    ).toEqual(['rbac:read']);
    expect(
      requiredPermissions(
        AdminRoleAssignmentsController.prototype.bulkPreview as unknown as object,
      ),
    ).toEqual(['rbac:read']);
  });

  it('gates the mutations on rbac:write', () => {
    for (const handler of [
      AdminRoleAssignmentsController.prototype.grant,
      AdminRoleAssignmentsController.prototype.revoke,
      AdminRoleAssignmentsController.prototype.bulkCommit,
    ]) {
      expect(requiredPermissions(handler as unknown as object)).toEqual(['rbac:write']);
    }
  });

  it('marks the mutations @Idempotent() but NOT the read-only routes', () => {
    for (const handler of [
      AdminRoleAssignmentsController.prototype.grant,
      AdminRoleAssignmentsController.prototype.revoke,
      AdminRoleAssignmentsController.prototype.bulkCommit,
    ]) {
      expect(
        Reflect.getMetadata(IDEMPOTENT_METADATA, handler as unknown as object) as unknown,
      ).toBe(true);
    }
    for (const handler of [
      AdminRoleAssignmentsController.prototype.listForUser,
      AdminRoleAssignmentsController.prototype.bulkPreview,
    ]) {
      expect(
        Reflect.getMetadata(IDEMPOTENT_METADATA, handler as unknown as object) as unknown,
      ).toBeUndefined();
    }
  });
});
