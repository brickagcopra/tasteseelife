import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { AdminUserActionsService, type AdminUserActionResult } from './admin-user-actions.service';

const NOW = new Date('2026-05-18T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60_000);

interface UserStoreRow {
  id: string;
  email: string;
  phone: string | null;
  status: 'pending_verification' | 'active' | 'suspended' | 'deactivated';
  mfaEnabled: boolean;
  emailVerifiedAt: Date | null;
  failedLoginCount: number;
  lastFailedLoginAt: Date | null;
  lockedUntil: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRoleStoreRow {
  userId: string;
  roleName: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

function buildPrismaFake(seed: {
  users: UserStoreRow[];
  userRoles?: UserRoleStoreRow[];
}): PrismaService {
  const users: UserStoreRow[] = seed.users.map((u) => ({ ...u }));
  const userRoles: UserRoleStoreRow[] = (seed.userRoles ?? []).map((r) => ({ ...r }));

  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
    const row = users.find((u) => u.id === where.id);
    return row ?? null;
  });

  const update = vi.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<UserStoreRow> }) => {
      const row = users.find((u) => u.id === where.id);
      if (row === undefined) {
        throw new Error('test fixture: update on missing row');
      }
      Object.assign(row, data);
      row.updatedAt = LATER;
      return { ...row };
    },
  );

  const findMany = vi.fn(
    async ({
      where,
    }: {
      where: {
        userId: string;
        revokedAt: null;
        OR: ReadonlyArray<{ expiresAt: null } | { expiresAt: { gt: Date } }>;
      };
    }) => {
      const now = NOW;
      return userRoles
        .filter(
          (r) =>
            r.userId === where.userId &&
            r.revokedAt === null &&
            (r.expiresAt === null || r.expiresAt.getTime() > now.getTime()),
        )
        .map((r) => ({ role: { name: r.roleName } }));
    },
  );

  const transaction = vi.fn(async (callback: (tx: unknown) => unknown) => {
    return callback({
      user: { findUnique, update },
      userRole: { findMany },
    });
  }) as unknown as PrismaService['$transaction'];

  return {
    user: { findUnique, update },
    userRole: { findMany },
    $transaction: transaction,
  } as unknown as PrismaService;
}

function baseUser(overrides: Partial<UserStoreRow> = {}): UserStoreRow {
  return {
    id: 'usr_1',
    email: 'alice@example.com',
    phone: null,
    status: 'active',
    mfaEnabled: false,
    emailVerifiedAt: null,
    failedLoginCount: 0,
    lastFailedLoginAt: null,
    lockedUntil: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function expectOk(
  result: AdminUserActionResult,
): asserts result is Extract<AdminUserActionResult, { ok: true }> {
  expect(result.ok).toBe(true);
}

function expectFailure(
  result: AdminUserActionResult,
): asserts result is Extract<AdminUserActionResult, { ok: false }> {
  expect(result.ok).toBe(false);
}

describe('AdminUserActionsService.suspend', () => {
  let prisma: PrismaService;
  let svc: AdminUserActionsService;

  beforeEach(() => {
    prisma = buildPrismaFake({
      users: [baseUser({ status: 'active' })],
    });
    svc = new AdminUserActionsService(prisma);
  });

  it('flips active → suspended and returns before/after snapshots', async () => {
    const result = await svc.suspend({
      userId: 'usr_1',
      actorUserId: 'admin_1',
      reason: 'trust_safety',
      note: 'chargeback investigation',
      now: NOW,
    });
    expectOk(result);
    expect(result.value.before.status).toBe('active');
    expect(result.value.after.status).toBe('suspended');
    expect(result.value.user.status).toBe('suspended');
    expect(result.value.performedAt).toEqual(NOW);
  });

  it('rejects when current status is suspended', async () => {
    prisma = buildPrismaFake({
      users: [baseUser({ status: 'suspended' })],
    });
    svc = new AdminUserActionsService(prisma);

    const result = await svc.suspend({
      userId: 'usr_1',
      actorUserId: 'admin_1',
      reason: 'trust_safety',
      note: null,
      now: NOW,
    });
    expectFailure(result);
    expect(result.failure.kind).toBe('illegal_transition');
    if (result.failure.kind === 'illegal_transition') {
      expect(result.failure.currentStatus).toBe('suspended');
      expect(result.failure.attempted).toBe('suspend');
    }
  });

  it('rejects when current status is pending_verification', async () => {
    prisma = buildPrismaFake({
      users: [baseUser({ status: 'pending_verification' })],
    });
    svc = new AdminUserActionsService(prisma);

    const result = await svc.suspend({
      userId: 'usr_1',
      actorUserId: 'admin_1',
      reason: 'trust_safety',
      note: null,
      now: NOW,
    });
    expectFailure(result);
    expect(result.failure.kind).toBe('illegal_transition');
  });

  it('rejects when current status is deactivated', async () => {
    prisma = buildPrismaFake({
      users: [baseUser({ status: 'deactivated' })],
    });
    svc = new AdminUserActionsService(prisma);

    const result = await svc.suspend({
      userId: 'usr_1',
      actorUserId: 'admin_1',
      reason: 'trust_safety',
      note: null,
      now: NOW,
    });
    expectFailure(result);
    expect(result.failure.kind).toBe('illegal_transition');
  });

  it('returns user_not_found when row is missing', async () => {
    const result = await svc.suspend({
      userId: 'usr_missing',
      actorUserId: 'admin_1',
      reason: 'trust_safety',
      note: null,
      now: NOW,
    });
    expectFailure(result);
    expect(result.failure.kind).toBe('user_not_found');
  });

  it('returns user_not_found when row is soft-deleted', async () => {
    prisma = buildPrismaFake({
      users: [baseUser({ status: 'active', deletedAt: NOW })],
    });
    svc = new AdminUserActionsService(prisma);

    const result = await svc.suspend({
      userId: 'usr_1',
      actorUserId: 'admin_1',
      reason: 'trust_safety',
      note: null,
      now: NOW,
    });
    expectFailure(result);
    expect(result.failure.kind).toBe('user_not_found');
  });

  it('denormalises role count + admin-role flag on the returned summary', async () => {
    prisma = buildPrismaFake({
      users: [baseUser({ status: 'active' })],
      userRoles: [
        { userId: 'usr_1', roleName: 'family_payer', revokedAt: null, expiresAt: null },
        { userId: 'usr_1', roleName: 'finance', revokedAt: null, expiresAt: null },
        { userId: 'usr_1', roleName: 'old_role', revokedAt: NOW, expiresAt: null },
      ],
    });
    svc = new AdminUserActionsService(prisma);

    const result = await svc.suspend({
      userId: 'usr_1',
      actorUserId: 'admin_1',
      reason: 'trust_safety',
      note: null,
      now: NOW,
    });
    expectOk(result);
    expect(result.value.user.activeRoleCount).toBe(2);
    expect(result.value.user.holdsAdminRole).toBe(true);
  });
});

describe('AdminUserActionsService.reinstate', () => {
  it('flips suspended → active', async () => {
    const prisma = buildPrismaFake({
      users: [baseUser({ status: 'suspended' })],
    });
    const svc = new AdminUserActionsService(prisma);

    const result = await svc.reinstate({
      userId: 'usr_1',
      actorUserId: 'admin_1',
      reason: 'investigation_complete',
      note: null,
      now: NOW,
    });
    expectOk(result);
    expect(result.value.before.status).toBe('suspended');
    expect(result.value.after.status).toBe('active');
  });

  it('rejects when current status is active', async () => {
    const prisma = buildPrismaFake({
      users: [baseUser({ status: 'active' })],
    });
    const svc = new AdminUserActionsService(prisma);

    const result = await svc.reinstate({
      userId: 'usr_1',
      actorUserId: 'admin_1',
      reason: 'user_request',
      note: null,
      now: NOW,
    });
    expectFailure(result);
    expect(result.failure.kind).toBe('illegal_transition');
    if (result.failure.kind === 'illegal_transition') {
      expect(result.failure.attempted).toBe('reinstate');
      expect(result.failure.currentStatus).toBe('active');
    }
  });

  it('does NOT reinstate a deactivated account', async () => {
    const prisma = buildPrismaFake({
      users: [baseUser({ status: 'deactivated' })],
    });
    const svc = new AdminUserActionsService(prisma);

    const result = await svc.reinstate({
      userId: 'usr_1',
      actorUserId: 'admin_1',
      reason: 'user_request',
      note: null,
      now: NOW,
    });
    expectFailure(result);
    // Permanent close is out of scope for reinstate; the surface
    // returns illegal_transition rather than success.
    expect(result.failure.kind).toBe('illegal_transition');
  });

  it('returns user_not_found when row is missing', async () => {
    const prisma = buildPrismaFake({ users: [] });
    const svc = new AdminUserActionsService(prisma);

    const result = await svc.reinstate({
      userId: 'usr_missing',
      actorUserId: 'admin_1',
      reason: 'user_request',
      note: null,
      now: NOW,
    });
    expectFailure(result);
    expect(result.failure.kind).toBe('user_not_found');
  });
});

describe('AdminUserActionsService.unlock', () => {
  it('clears lockout columns on a locked account', async () => {
    const prisma = buildPrismaFake({
      users: [
        baseUser({
          status: 'active',
          failedLoginCount: 7,
          lastFailedLoginAt: NOW,
          lockedUntil: LATER,
        }),
      ],
    });
    const svc = new AdminUserActionsService(prisma);

    const result = await svc.unlock({
      userId: 'usr_1',
      actorUserId: 'admin_1',
      note: 'support ticket',
      now: NOW,
    });
    expectOk(result);
    expect(result.value.before.failedLoginCount).toBe(7);
    expect(result.value.before.lockedUntil).toEqual(LATER);
    expect(result.value.after.failedLoginCount).toBe(0);
    expect(result.value.after.lastFailedLoginAt).toBeNull();
    expect(result.value.after.lockedUntil).toBeNull();
    expect(result.value.user.currentlyLocked).toBe(false);
  });

  it('is a no-op success on an already-clear account', async () => {
    const prisma = buildPrismaFake({
      users: [baseUser({ status: 'active' })],
    });
    const svc = new AdminUserActionsService(prisma);

    const result = await svc.unlock({
      userId: 'usr_1',
      actorUserId: 'admin_1',
      note: null,
      now: NOW,
    });
    expectOk(result);
    expect(result.value.before.lockedUntil).toBeNull();
    expect(result.value.after.lockedUntil).toBeNull();
    expect(result.value.user.currentlyLocked).toBe(false);
  });

  it('does NOT mutate the status', async () => {
    const prisma = buildPrismaFake({
      users: [
        baseUser({
          status: 'suspended',
          failedLoginCount: 4,
          lastFailedLoginAt: NOW,
          lockedUntil: LATER,
        }),
      ],
    });
    const svc = new AdminUserActionsService(prisma);

    const result = await svc.unlock({
      userId: 'usr_1',
      actorUserId: 'admin_1',
      note: null,
      now: NOW,
    });
    expectOk(result);
    expect(result.value.before.status).toBe('suspended');
    expect(result.value.after.status).toBe('suspended');
    expect(result.value.user.status).toBe('suspended');
  });

  it('returns user_not_found when row is missing', async () => {
    const prisma = buildPrismaFake({ users: [] });
    const svc = new AdminUserActionsService(prisma);

    const result = await svc.unlock({
      userId: 'usr_missing',
      actorUserId: 'admin_1',
      note: null,
      now: NOW,
    });
    expectFailure(result);
    expect(result.failure.kind).toBe('user_not_found');
  });

  it('returns user_not_found when row is soft-deleted', async () => {
    const prisma = buildPrismaFake({
      users: [baseUser({ status: 'active', deletedAt: NOW })],
    });
    const svc = new AdminUserActionsService(prisma);

    const result = await svc.unlock({
      userId: 'usr_1',
      actorUserId: 'admin_1',
      note: null,
      now: NOW,
    });
    expectFailure(result);
    expect(result.failure.kind).toBe('user_not_found');
  });
});
