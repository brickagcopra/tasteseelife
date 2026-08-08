import 'reflect-metadata';

import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminUsersListQuery,
  ReinstateUserRequest,
  SuspendUserRequest,
  UnlockUserRequest,
} from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';

import type {
  AdminUserActionResult,
  AdminUserActionsService,
  AdminUserActionSuccess,
} from '../services/admin-user-actions.service';
import type {
  AdminUserDetailRow,
  AdminUserListPage,
  AdminUserListRow,
  AdminUsersService,
} from '../services/admin-users.service';

import { AdminUsersController } from './admin-users.controller';

const NOW = new Date('2026-05-17T12:00:00.000Z');

function buildService(
  overrides: Partial<{
    list: AdminUsersService['list'];
    getById: AdminUsersService['getById'];
  }> = {},
): AdminUsersService {
  return {
    list:
      overrides.list ?? (vi.fn(async () => emptyPage()) as unknown as AdminUsersService['list']),
    getById:
      overrides.getById ?? (vi.fn(async () => null) as unknown as AdminUsersService['getById']),
  } as unknown as AdminUsersService;
}

function buildActionsService(
  overrides: Partial<{
    suspend: AdminUserActionsService['suspend'];
    reinstate: AdminUserActionsService['reinstate'];
    unlock: AdminUserActionsService['unlock'];
  }> = {},
): AdminUserActionsService {
  const noop = vi.fn(async () => failure({ kind: 'user_not_found' }));
  return {
    suspend: overrides.suspend ?? (noop as unknown as AdminUserActionsService['suspend']),
    reinstate: overrides.reinstate ?? (noop as unknown as AdminUserActionsService['reinstate']),
    unlock: overrides.unlock ?? (noop as unknown as AdminUserActionsService['unlock']),
  } as unknown as AdminUserActionsService;
}

function actorRequest(userId = 'admin_1'): RequestWithContext {
  return {
    requestContext: {
      userId,
      roles: [{ name: 'super_admin', permissions: [], scope: { type: 'global' } }],
      sessionId: 'sess_1',
    },
  } as unknown as RequestWithContext;
}

function userListRow(overrides: Partial<AdminUserListRow> = {}): AdminUserListRow {
  return {
    id: 'usr_1',
    email: 'alice@example.com',
    phone: null,
    status: 'suspended',
    mfaEnabled: false,
    emailVerifiedAt: null,
    activeRoleCount: 1,
    holdsAdminRole: false,
    currentlyLocked: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function success(overrides: Partial<AdminUserActionSuccess> = {}): AdminUserActionResult {
  return {
    ok: true,
    value: {
      userId: 'usr_1',
      before: {
        status: 'active',
        failedLoginCount: 0,
        lastFailedLoginAt: null,
        lockedUntil: null,
      },
      after: {
        status: 'suspended',
        failedLoginCount: 0,
        lastFailedLoginAt: null,
        lockedUntil: null,
      },
      user: userListRow(),
      performedAt: NOW,
      ...overrides,
    },
  };
}

function failure(
  variant:
    | { kind: 'user_not_found' }
    | {
        kind: 'illegal_transition';
        currentStatus: 'pending_verification' | 'active' | 'suspended' | 'deactivated';
        attempted: 'suspend' | 'reinstate';
      },
): AdminUserActionResult {
  return { ok: false, failure: variant };
}

function emptyPage(): AdminUserListPage {
  return { users: [], nextCursor: null };
}

function detailRow(overrides: Partial<AdminUserDetailRow> = {}): AdminUserDetailRow {
  return {
    id: 'usr_1',
    email: 'alice@example.com',
    phone: '+15551112222',
    status: 'active',
    mfaEnabled: false,
    emailVerifiedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    roles: [
      {
        id: 'ur_1',
        name: 'family_payer',
        permissions: [],
        scope: { type: 'global' },
        expiresAt: null,
      },
    ],
    holdsAdminRole: false,
    mfaMethods: [],
    latestKyc: null,
    lockout: {
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
      currentlyLocked: false,
    },
    ...overrides,
  };
}

describe('AdminUsersController.list', () => {
  it('returns an empty page when the service has no users', async () => {
    const svc = buildService();
    const ctrl = new AdminUsersController(svc, buildActionsService());

    const response = await ctrl.list({ limit: 25 } as AdminUsersListQuery);
    expect(response.users).toEqual([]);
    expect(response.nextCursor).toBeNull();
  });

  it('maps the service row shape to the DTO shape (ISO date serialisation)', async () => {
    const svc = buildService({
      list: vi.fn(async () => ({
        users: [
          {
            id: 'usr_1',
            email: 'alice@example.com',
            phone: '+15551112222',
            status: 'active' as const,
            mfaEnabled: true,
            emailVerifiedAt: NOW,
            activeRoleCount: 2,
            holdsAdminRole: true,
            currentlyLocked: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        nextCursor: 'opaque_cursor',
      })) as unknown as AdminUsersService['list'],
    });
    const ctrl = new AdminUsersController(svc, buildActionsService());

    const response = await ctrl.list({ limit: 25 } as AdminUsersListQuery);
    expect(response.users[0]?.id).toBe('usr_1');
    expect(response.users[0]?.emailVerifiedAt).toBe(NOW.toISOString());
    expect(response.users[0]?.createdAt).toBe(NOW.toISOString());
    expect(response.nextCursor).toBe('opaque_cursor');
  });

  it('forwards every optional filter to the service', async () => {
    const listSpy = vi.fn(async () => emptyPage());
    const svc = buildService({ list: listSpy as unknown as AdminUsersService['list'] });
    const ctrl = new AdminUsersController(svc, buildActionsService());

    await ctrl.list({
      q: 'alice',
      status: 'suspended',
      roleName: 'finance',
      cursor: 'cur_abc',
      limit: 50,
    });
    expect(listSpy).toHaveBeenCalledWith({
      q: 'alice',
      status: 'suspended',
      roleName: 'finance',
      cursor: 'cur_abc',
      limit: 50,
    });
  });

  it('omits undefined optional filters when forwarding', async () => {
    const listSpy = vi.fn(async () => emptyPage());
    const svc = buildService({ list: listSpy as unknown as AdminUsersService['list'] });
    const ctrl = new AdminUsersController(svc, buildActionsService());

    await ctrl.list({ limit: 25 } as AdminUsersListQuery);
    expect(listSpy).toHaveBeenCalledWith({ limit: 25 });
  });
});

describe('AdminUsersController.getById', () => {
  it('throws 404 when the id is empty', async () => {
    const svc = buildService();
    const ctrl = new AdminUsersController(svc, buildActionsService());

    await expect(ctrl.getById('')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 404 when the service returns null', async () => {
    const svc = buildService({
      getById: vi.fn(async () => null) as unknown as AdminUsersService['getById'],
    });
    const ctrl = new AdminUsersController(svc, buildActionsService());

    await expect(ctrl.getById('usr_missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the wrapped detail DTO on a hit', async () => {
    const svc = buildService({
      getById: vi.fn(async () => detailRow()) as unknown as AdminUsersService['getById'],
    });
    const ctrl = new AdminUsersController(svc, buildActionsService());

    const response = await ctrl.getById('usr_1');
    expect(response.user.id).toBe('usr_1');
    expect(response.user.roles[0]?.name).toBe('family_payer');
    expect(response.user.holdsAdminRole).toBe(false);
  });

  it('serialises every Date column to ISO', async () => {
    const earlier = new Date(NOW.getTime() - 60_000);
    const svc = buildService({
      getById: vi.fn(async () =>
        detailRow({
          mfaMethods: [
            {
              id: 'mfa_1',
              kind: 'totp',
              label: 'iPhone',
              confirmedAt: earlier,
              lastUsedAt: NOW,
              createdAt: earlier,
            },
          ],
          latestKyc: {
            id: 'kyc_1',
            status: 'verified',
            verifiedAt: NOW,
            createdAt: earlier,
            updatedAt: NOW,
          },
        }),
      ) as unknown as AdminUsersService['getById'],
    });
    const ctrl = new AdminUsersController(svc, buildActionsService());

    const response = await ctrl.getById('usr_1');
    expect(response.user.mfaMethods[0]?.confirmedAt).toBe(earlier.toISOString());
    expect(response.user.latestKyc?.verifiedAt).toBe(NOW.toISOString());
  });
});

describe('AdminUsersController.suspend (TS-126-followup-1)', () => {
  it('returns 401 when the actor context is missing', async () => {
    const actions = buildActionsService({
      suspend: vi.fn(async () => success()) as unknown as AdminUserActionsService['suspend'],
    });
    const ctrl = new AdminUsersController(buildService(), actions);

    await expect(
      ctrl.suspend(
        'usr_1',
        { reason: 'trust_safety' } as SuspendUserRequest,
        {} as RequestWithContext,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 404 when the id is empty', async () => {
    const actions = buildActionsService();
    const ctrl = new AdminUsersController(buildService(), actions);

    await expect(
      ctrl.suspend('', { reason: 'trust_safety' } as SuspendUserRequest, actorRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 when the service reports user_not_found', async () => {
    const actions = buildActionsService({
      suspend: vi.fn(async () =>
        failure({ kind: 'user_not_found' }),
      ) as unknown as AdminUserActionsService['suspend'],
    });
    const ctrl = new AdminUsersController(buildService(), actions);

    await expect(
      ctrl.suspend('usr_x', { reason: 'trust_safety' } as SuspendUserRequest, actorRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 409 on illegal_transition', async () => {
    const actions = buildActionsService({
      suspend: vi.fn(async () =>
        failure({ kind: 'illegal_transition', currentStatus: 'suspended', attempted: 'suspend' }),
      ) as unknown as AdminUserActionsService['suspend'],
    });
    const ctrl = new AdminUsersController(buildService(), actions);

    await expect(
      ctrl.suspend('usr_1', { reason: 'trust_safety' } as SuspendUserRequest, actorRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns the wrapped action response on success', async () => {
    const suspendSpy = vi.fn(async () => success());
    const actions = buildActionsService({
      suspend: suspendSpy as unknown as AdminUserActionsService['suspend'],
    });
    const ctrl = new AdminUsersController(buildService(), actions);

    const response = await ctrl.suspend(
      'usr_1',
      { reason: 'trust_safety', note: 'spike in failed payments' } as SuspendUserRequest,
      actorRequest('admin_42'),
    );
    expect(response.action).toBe('suspend');
    expect(response.reason).toBe('trust_safety');
    expect(response.note).toBe('spike in failed payments');
    expect(response.performedByUserId).toBe('admin_42');
    expect(response.after.status).toBe('suspended');
    expect(suspendSpy).toHaveBeenCalledWith({
      userId: 'usr_1',
      actorUserId: 'admin_42',
      reason: 'trust_safety',
      note: 'spike in failed payments',
    });
  });

  it('passes note=null when the request omits it', async () => {
    const suspendSpy = vi.fn(async () => success());
    const actions = buildActionsService({
      suspend: suspendSpy as unknown as AdminUserActionsService['suspend'],
    });
    const ctrl = new AdminUsersController(buildService(), actions);

    await ctrl.suspend('usr_1', { reason: 'investigation' } as SuspendUserRequest, actorRequest());
    expect(suspendSpy).toHaveBeenCalledWith({
      userId: 'usr_1',
      actorUserId: 'admin_1',
      reason: 'investigation',
      note: null,
    });
  });
});

describe('AdminUsersController.reinstate (TS-126-followup-1)', () => {
  it('returns the wrapped action response on success', async () => {
    const reinstateSpy = vi.fn(async () =>
      success({
        before: {
          status: 'suspended',
          failedLoginCount: 0,
          lastFailedLoginAt: null,
          lockedUntil: null,
        },
        after: {
          status: 'active',
          failedLoginCount: 0,
          lastFailedLoginAt: null,
          lockedUntil: null,
        },
        user: userListRow({ status: 'active' }),
      }),
    );
    const actions = buildActionsService({
      reinstate: reinstateSpy as unknown as AdminUserActionsService['reinstate'],
    });
    const ctrl = new AdminUsersController(buildService(), actions);

    const response = await ctrl.reinstate(
      'usr_1',
      { reason: 'investigation_complete' } as ReinstateUserRequest,
      actorRequest(),
    );
    expect(response.action).toBe('reinstate');
    expect(response.before.status).toBe('suspended');
    expect(response.after.status).toBe('active');
  });

  it('returns 409 when current status is not suspended', async () => {
    const actions = buildActionsService({
      reinstate: vi.fn(async () =>
        failure({ kind: 'illegal_transition', currentStatus: 'active', attempted: 'reinstate' }),
      ) as unknown as AdminUserActionsService['reinstate'],
    });
    const ctrl = new AdminUsersController(buildService(), actions);

    await expect(
      ctrl.reinstate('usr_1', { reason: 'user_request' } as ReinstateUserRequest, actorRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('AdminUsersController.unlock (TS-126-followup-1)', () => {
  it('returns the wrapped action response on success (reason is null)', async () => {
    const unlockSpy = vi.fn(async () =>
      success({
        before: {
          status: 'active',
          failedLoginCount: 7,
          lastFailedLoginAt: NOW,
          lockedUntil: new Date(NOW.getTime() + 60_000),
        },
        after: {
          status: 'active',
          failedLoginCount: 0,
          lastFailedLoginAt: null,
          lockedUntil: null,
        },
      }),
    );
    const actions = buildActionsService({
      unlock: unlockSpy as unknown as AdminUserActionsService['unlock'],
    });
    const ctrl = new AdminUsersController(buildService(), actions);

    const response = await ctrl.unlock(
      'usr_1',
      { note: 'support ticket S-123' } as UnlockUserRequest,
      actorRequest(),
    );
    expect(response.action).toBe('unlock');
    expect(response.reason).toBeNull();
    expect(response.note).toBe('support ticket S-123');
    expect(response.before.failedLoginCount).toBe(7);
    expect(response.after.failedLoginCount).toBe(0);
  });

  it('returns 404 when the service reports user_not_found', async () => {
    const actions = buildActionsService({
      unlock: vi.fn(async () =>
        failure({ kind: 'user_not_found' }),
      ) as unknown as AdminUserActionsService['unlock'],
    });
    const ctrl = new AdminUsersController(buildService(), actions);

    await expect(
      ctrl.unlock('usr_x', {} as UnlockUserRequest, actorRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AdminUsersController idempotency wiring (TS-126-followup-1)', () => {
  it('marks POST /api/v1/admin/users/:id/suspend as @Idempotent()', () => {
    const handler = AdminUsersController.prototype.suspend as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('marks POST /api/v1/admin/users/:id/reinstate as @Idempotent()', () => {
    const handler = AdminUsersController.prototype.reinstate as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('marks POST /api/v1/admin/users/:id/unlock as @Idempotent()', () => {
    const handler = AdminUsersController.prototype.unlock as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  // GET endpoints stay un-decorated — tagging them would burn a Redis
  // round-trip on every read with no behavioural gain.
  it('does NOT mark GET /api/v1/admin/users as @Idempotent()', () => {
    const handler = AdminUsersController.prototype.list as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });

  it('does NOT mark GET /api/v1/admin/users/:id as @Idempotent()', () => {
    const handler = AdminUsersController.prototype.getById as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });
});
