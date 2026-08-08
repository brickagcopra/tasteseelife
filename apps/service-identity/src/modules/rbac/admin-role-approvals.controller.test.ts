import 'reflect-metadata';

import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { AdminRoleApprovalRecord } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { REQUIRE_PERMISSIONS_METADATA_KEY } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';

import { AdminRoleApprovalsController } from './admin-role-approvals.controller';
import type { RoleAssignmentApprovalService } from './role-assignment-approval.service';

const NOW_ISO = '2026-07-01T12:00:00.000Z';

function wireRecord(overrides: Partial<AdminRoleApprovalRecord> = {}): AdminRoleApprovalRecord {
  return {
    id: 'apr_1',
    userId: 'user_1',
    roleName: 'finance',
    scope: { type: 'global' },
    expiresAt: null,
    requestedByUserId: 'admin_1',
    reason: 'quarter close',
    status: 'pending',
    approvedByUserId: null,
    decidedAt: null,
    decisionNote: null,
    userRoleId: null,
    createdAt: NOW_ISO,
    ...overrides,
  };
}

function buildService(
  overrides: Partial<{
    list: RoleAssignmentApprovalService['list'];
    requestGrant: RoleAssignmentApprovalService['requestGrant'];
    approve: RoleAssignmentApprovalService['approve'];
    reject: RoleAssignmentApprovalService['reject'];
  }> = {},
): RoleAssignmentApprovalService {
  return {
    list:
      overrides.list ?? (vi.fn(async () => []) as unknown as RoleAssignmentApprovalService['list']),
    requestGrant:
      overrides.requestGrant ??
      (vi.fn(async () => wireRecord()) as unknown as RoleAssignmentApprovalService['requestGrant']),
    approve:
      overrides.approve ??
      (vi.fn(async () =>
        wireRecord({ status: 'approved', approvedByUserId: 'admin_2', userRoleId: 'ur_9' }),
      ) as unknown as RoleAssignmentApprovalService['approve']),
    reject:
      overrides.reject ??
      (vi.fn(async () =>
        wireRecord({ status: 'rejected', approvedByUserId: 'admin_2' }),
      ) as unknown as RoleAssignmentApprovalService['reject']),
  } as unknown as RoleAssignmentApprovalService;
}

function actorRequest(userId = 'admin_2', roleNames: readonly string[] = ['super_admin']) {
  return {
    requestContext: {
      userId,
      roles: roleNames.map((name) => ({
        name,
        permissions: ['rbac:read', 'rbac:write'],
        scope: { type: 'global' },
      })),
      tenantScope: { type: 'global' },
      sessionId: 'sess_1',
    },
    // The audit actor builder (TS-295) reads request metadata.
    ip: '203.0.113.9',
    headers: {},
  } as unknown as RequestWithContext;
}

describe('AdminRoleApprovalsController', () => {
  it('lists through the contract envelope with the status filter', async () => {
    const list = vi.fn(async () => [wireRecord()]);
    const controller = new AdminRoleApprovalsController(
      buildService({ list: list as unknown as RoleAssignmentApprovalService['list'] }),
    );

    const response = await controller.list({ status: 'pending' });
    expect(list).toHaveBeenCalledWith({ status: 'pending' });
    expect(response.approvals).toEqual([wireRecord()]);
  });

  it('requests with the actor from the request context', async () => {
    const requestGrant = vi.fn(async () => wireRecord());
    const controller = new AdminRoleApprovalsController(
      buildService({
        requestGrant: requestGrant as unknown as RoleAssignmentApprovalService['requestGrant'],
      }),
    );

    const response = await controller.request(
      {
        userId: 'user_1',
        roleName: 'finance',
        scope: { type: 'global' },
        reason: 'quarter close',
      },
      actorRequest('admin_1'),
    );
    expect(requestGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ actorUserId: 'admin_1' }),
        reason: 'quarter close',
      }),
    );
    expect(response.approval.id).toBe('apr_1');
  });

  it('passes the actor role NAMES into approve — the service enforces the super_admin check', async () => {
    const approve = vi.fn(async () =>
      wireRecord({ status: 'approved', approvedByUserId: 'admin_2', userRoleId: 'ur_9' }),
    );
    const controller = new AdminRoleApprovalsController(
      buildService({ approve: approve as unknown as RoleAssignmentApprovalService['approve'] }),
    );

    await controller.approve(
      'apr_1',
      { note: 'ok' },
      actorRequest('admin_2', ['super_admin', 'operations_manager']),
    );
    expect(approve).toHaveBeenCalledWith({
      approvalId: 'apr_1',
      actor: expect.objectContaining({ actorUserId: 'admin_2' }),
      actorRoleNames: ['super_admin', 'operations_manager'],
      note: 'ok',
    });
  });

  it('rejects with the actor and optional note', async () => {
    const reject = vi.fn(async () => wireRecord({ status: 'rejected' }));
    const controller = new AdminRoleApprovalsController(
      buildService({ reject: reject as unknown as RoleAssignmentApprovalService['reject'] }),
    );

    const response = await controller.reject('apr_1', {}, actorRequest('admin_1', []));
    expect(reject).toHaveBeenCalledWith({
      approvalId: 'apr_1',
      actor: expect.objectContaining({ actorUserId: 'admin_1' }),
      actorRoleNames: [],
    });
    expect(response.approval.status).toBe('rejected');
  });

  it('401s mutations without a request context', async () => {
    const controller = new AdminRoleApprovalsController(buildService());
    await expect(
      controller.request(
        { userId: 'u', roleName: 'finance', scope: { type: 'global' }, reason: 'x' },
        {} as RequestWithContext,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.approve('apr_1', {}, {} as RequestWithContext)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('404s an oversized approval id without hitting the service', async () => {
    const approve = vi.fn(async () => wireRecord());
    const controller = new AdminRoleApprovalsController(
      buildService({ approve: approve as unknown as RoleAssignmentApprovalService['approve'] }),
    );
    await expect(controller.approve('x'.repeat(65), {}, actorRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(approve).not.toHaveBeenCalled();
  });
});

describe('AdminRoleApprovalsController permission gating (TS-294)', () => {
  function requiredPermissions(handler: object): unknown {
    return Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, handler);
  }

  it('gates the list on rbac:read and the mutations on rbac:write', () => {
    expect(
      requiredPermissions(AdminRoleApprovalsController.prototype.list as unknown as object),
    ).toEqual(['rbac:read']);
    for (const handler of [
      AdminRoleApprovalsController.prototype.request,
      AdminRoleApprovalsController.prototype.approve,
      AdminRoleApprovalsController.prototype.reject,
    ]) {
      expect(requiredPermissions(handler as unknown as object)).toEqual(['rbac:write']);
    }
  });

  it('marks the mutations @Idempotent() but not the list', () => {
    for (const handler of [
      AdminRoleApprovalsController.prototype.request,
      AdminRoleApprovalsController.prototype.approve,
      AdminRoleApprovalsController.prototype.reject,
    ]) {
      expect(
        Reflect.getMetadata(IDEMPOTENT_METADATA, handler as unknown as object) as unknown,
      ).toBe(true);
    }
    expect(
      Reflect.getMetadata(
        IDEMPOTENT_METADATA,
        AdminRoleApprovalsController.prototype.list as unknown as object,
      ) as unknown,
    ).toBeUndefined();
  });
});
