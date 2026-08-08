import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import type { RoleAssignmentService } from '../../rbac/role-assignment.service';

import { AdminUsersService, decodeCursor, encodeCursor } from './admin-users.service';

const NOW = new Date('2026-05-17T12:00:00.000Z');

type FakeUserRow = {
  id: string;
  email: string;
  phone: string | null;
  status: 'pending_verification' | 'active' | 'suspended' | 'deactivated';
  mfaEnabled: boolean;
  emailVerifiedAt: Date | null;
  failedLoginCount: number;
  lastFailedLoginAt: Date | null;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type FakeUserRoleRow = {
  id: string;
  userId: string;
  roleId: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  scopeType: 'global' | 'tenant' | 'household';
  scopeId: string | null;
  role: { name: string };
};

type FakeMfaRow = {
  id: string;
  userId: string;
  kind: 'totp' | 'sms_backup';
  label: string | null;
  confirmedAt: Date | null;
  deletedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

type FakeKycRow = {
  id: string;
  userId: string;
  status: 'pending' | 'processing' | 'verified' | 'requires_input' | 'failed' | 'canceled';
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function buildFakePrisma(input: {
  users: FakeUserRow[];
  userRoles?: FakeUserRoleRow[];
  mfaMethods?: FakeMfaRow[];
  kycRecords?: FakeKycRow[];
}): PrismaService {
  const users = [...input.users];
  const userRoles = [...(input.userRoles ?? [])];
  const mfaMethods = [...(input.mfaMethods ?? [])];
  const kycRecords = [...(input.kycRecords ?? [])];

  // Naive in-memory matcher for the subset of Prisma operators the
  // service uses. Covers `equals`, `not: null`, `contains+mode`,
  // `in: [...]`, `lt`, `gt`, and OR/AND boolean combinators.
  function matchesValue(value: unknown, predicate: unknown): boolean {
    if (predicate === null) return value === null;
    if (predicate instanceof Date) {
      return value instanceof Date && value.getTime() === predicate.getTime();
    }
    if (typeof predicate !== 'object') {
      return value === predicate;
    }
    const obj = predicate as Record<string, unknown>;
    if ('not' in obj) {
      return !matchesValue(value, obj['not']);
    }
    if ('contains' in obj) {
      const needle = String(obj['contains']);
      const haystack = String(value ?? '');
      if (obj['mode'] === 'insensitive') {
        return haystack.toLowerCase().includes(needle.toLowerCase());
      }
      return haystack.includes(needle);
    }
    if ('in' in obj) {
      const arr = obj['in'] as readonly unknown[];
      return arr.some((candidate) => matchesValue(value, candidate));
    }
    if ('lt' in obj) {
      const target = obj['lt'];
      if (target instanceof Date && value instanceof Date) {
        return value.getTime() < target.getTime();
      }
      return (value as number) < (target as number);
    }
    if ('gt' in obj) {
      const target = obj['gt'];
      if (target instanceof Date && value instanceof Date) {
        return value.getTime() > target.getTime();
      }
      return (value as number) > (target as number);
    }
    if ('equals' in obj) {
      return matchesValue(value, obj['equals']);
    }
    return false;
  }

  function rowMatchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    for (const [key, predicate] of Object.entries(where)) {
      if (key === 'OR') {
        const arr = predicate as Array<Record<string, unknown>>;
        if (!arr.some((p) => rowMatchesWhere(row, p))) return false;
        continue;
      }
      if (key === 'AND') {
        const arr = predicate as Array<Record<string, unknown>>;
        if (!arr.every((p) => rowMatchesWhere(row, p))) return false;
        continue;
      }
      if (key === 'role') {
        // Nested role.name predicate for userRole rows.
        const inner = predicate as { name?: unknown };
        const roleObj = (row['role'] ?? {}) as { name?: string };
        if (inner.name !== undefined && !matchesValue(roleObj.name, inner.name)) return false;
        continue;
      }
      if (key === 'roles') {
        // TS-126-followup-6: User → UserRole back-reference. The
        // `some` predicate matches if ANY userRole row whose
        // `userId` equals this user's id satisfies the inner where.
        const inner = predicate as { some?: Record<string, unknown> };
        if (inner.some === undefined) return false;
        const userId = row['id'] as string;
        const related = userRoles.filter((r) => r.userId === userId);
        if (
          !related.some((r) =>
            rowMatchesWhere(r as unknown as Record<string, unknown>, inner.some!),
          )
        ) {
          return false;
        }
        continue;
      }
      if (!matchesValue(row[key], predicate)) return false;
    }
    return true;
  }

  const prisma = {
    user: {
      findMany: vi.fn(
        async (args: {
          where?: Record<string, unknown>;
          select?: Record<string, true>;
          orderBy?: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
          take?: number;
        }): Promise<FakeUserRow[]> => {
          const where = args.where ?? {};
          let filtered = users.filter((u) =>
            rowMatchesWhere(u as unknown as Record<string, unknown>, where),
          );
          if (args.orderBy !== undefined) {
            filtered = [...filtered].sort((a, b) => {
              for (const clause of args.orderBy!) {
                const [k, dir] = Object.entries(clause)[0]!;
                const av = (a as Record<string, unknown>)[k] as Date | string;
                const bv = (b as Record<string, unknown>)[k] as Date | string;
                const cmp =
                  av instanceof Date && bv instanceof Date
                    ? av.getTime() - bv.getTime()
                    : av < bv
                      ? -1
                      : av > bv
                        ? 1
                        : 0;
                if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
              }
              return 0;
            });
          }
          if (args.take !== undefined) filtered = filtered.slice(0, args.take);
          return filtered;
        },
      ),
      findUnique: vi.fn(async (args: { where: { id: string } }): Promise<FakeUserRow | null> => {
        return users.find((u) => u.id === args.where.id) ?? null;
      }),
    },
    userRole: {
      findMany: vi.fn(
        async (args: {
          where?: Record<string, unknown>;
        }): Promise<Array<{ userId: string; role: { name: string } }>> => {
          const where = args.where ?? {};
          return userRoles
            .filter((r) => rowMatchesWhere(r as unknown as Record<string, unknown>, where))
            .map((r) => ({ userId: r.userId, role: { name: r.role.name } }));
        },
      ),
    },
    mfaMethod: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }): Promise<FakeMfaRow[]> => {
        const where = args.where ?? {};
        return mfaMethods.filter((m) =>
          rowMatchesWhere(m as unknown as Record<string, unknown>, where),
        );
      }),
    },
    kycRecord: {
      findFirst: vi.fn(
        async (args: {
          where?: Record<string, unknown>;
          orderBy?: Record<string, 'asc' | 'desc'>;
        }): Promise<FakeKycRow | null> => {
          const where = args.where ?? {};
          let filtered = kycRecords.filter((k) =>
            rowMatchesWhere(k as unknown as Record<string, unknown>, where),
          );
          if (args.orderBy !== undefined) {
            const [k, dir] = Object.entries(args.orderBy)[0]!;
            filtered = [...filtered].sort((a, b) => {
              const av = (a as Record<string, unknown>)[k] as Date;
              const bv = (b as Record<string, unknown>)[k] as Date;
              const cmp = av.getTime() - bv.getTime();
              return dir === 'desc' ? -cmp : cmp;
            });
          }
          return filtered[0] ?? null;
        },
      ),
    },
  } as unknown as PrismaService;
  return prisma;
}

function buildRoleAssignmentFake(
  rolesByUser: Record<string, ReturnType<typeof makeRoleRecord>[]>,
): RoleAssignmentService {
  return {
    listForUser: vi.fn(async (userId: string) => rolesByUser[userId] ?? []),
  } as unknown as RoleAssignmentService;
}

function makeRoleRecord(name: string, scope: { type: 'global' } = { type: 'global' }) {
  return {
    id: `ur_${name}_${Math.random().toString(36).slice(2, 8)}`,
    assignment: { name, permissions: [], scope },
    active: true,
    revokedAt: null,
  };
}

function makeUserRow(overrides: Partial<FakeUserRow> = {}): FakeUserRow {
  return {
    id: 'usr_1',
    email: 'alice@example.com',
    phone: '+15551112222',
    status: 'active',
    mfaEnabled: false,
    emailVerifiedAt: NOW,
    failedLoginCount: 0,
    lastFailedLoginAt: null,
    lockedUntil: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

describe('AdminUsersService — cursor codec', () => {
  it('round-trips a createdAt + id pair', () => {
    const cursor = encodeCursor(NOW, 'usr_abc');
    const decoded = decodeCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.createdAt.getTime()).toBe(NOW.getTime());
    expect(decoded!.id).toBe('usr_abc');
  });

  it('returns null on undefined input', () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('returns null on a non-base64url input', () => {
    expect(decodeCursor('***not-base64***')).toBeNull();
  });

  it('returns null on a base64 payload missing the pipe', () => {
    const bad = Buffer.from('no-pipe-here', 'utf8').toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('returns null on an unparseable ISO date', () => {
    const bad = Buffer.from('not-a-date|usr_1', 'utf8').toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
});

describe('AdminUsersService.list', () => {
  it('returns an empty page when no users exist', async () => {
    const prisma = buildFakePrisma({ users: [] });
    const roles = buildRoleAssignmentFake({});
    const svc = new AdminUsersService(prisma, roles);

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.users).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('filters by email substring (case-insensitive)', async () => {
    const prisma = buildFakePrisma({
      users: [
        makeUserRow({ id: 'usr_1', email: 'alice@example.com' }),
        makeUserRow({ id: 'usr_2', email: 'bob@example.com' }),
        makeUserRow({ id: 'usr_3', email: 'CAROL@example.com' }),
      ],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const page = await svc.list({ q: 'alice', limit: 25, now: NOW });
    expect(page.users.map((u) => u.id)).toEqual(['usr_1']);

    const caseInsensitive = await svc.list({ q: 'carol', limit: 25, now: NOW });
    expect(caseInsensitive.users.map((u) => u.id)).toEqual(['usr_3']);
  });

  it('filters by exact status', async () => {
    const prisma = buildFakePrisma({
      users: [
        makeUserRow({ id: 'usr_1', status: 'active' }),
        makeUserRow({ id: 'usr_2', status: 'suspended' }),
      ],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const page = await svc.list({ status: 'suspended', limit: 25, now: NOW });
    expect(page.users.map((u) => u.id)).toEqual(['usr_2']);
  });

  it('excludes soft-deleted users by default', async () => {
    const prisma = buildFakePrisma({
      users: [makeUserRow({ id: 'usr_1' }), makeUserRow({ id: 'usr_2', deletedAt: NOW })],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.users.map((u) => u.id)).toEqual(['usr_1']);
  });

  it('emits a nextCursor when more rows exist than the limit', async () => {
    const earlier = new Date(NOW.getTime() - 60_000);
    const earlierStill = new Date(NOW.getTime() - 120_000);
    const prisma = buildFakePrisma({
      users: [
        makeUserRow({ id: 'usr_1', createdAt: NOW }),
        makeUserRow({ id: 'usr_2', createdAt: earlier }),
        makeUserRow({ id: 'usr_3', createdAt: earlierStill }),
      ],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const page = await svc.list({ limit: 2, now: NOW });
    expect(page.users.map((u) => u.id)).toEqual(['usr_1', 'usr_2']);
    expect(page.nextCursor).not.toBeNull();

    const decoded = decodeCursor(page.nextCursor ?? undefined);
    expect(decoded?.id).toBe('usr_2');
  });

  it('does not emit a nextCursor when fewer rows than the limit exist', async () => {
    const prisma = buildFakePrisma({
      users: [makeUserRow({ id: 'usr_1' })],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.users.length).toBe(1);
    expect(page.nextCursor).toBeNull();
  });

  it('continues from the cursor on the next page', async () => {
    const t0 = new Date(NOW.getTime());
    const t1 = new Date(NOW.getTime() - 60_000);
    const t2 = new Date(NOW.getTime() - 120_000);
    const t3 = new Date(NOW.getTime() - 180_000);
    const prisma = buildFakePrisma({
      users: [
        makeUserRow({ id: 'usr_1', createdAt: t0 }),
        makeUserRow({ id: 'usr_2', createdAt: t1 }),
        makeUserRow({ id: 'usr_3', createdAt: t2 }),
        makeUserRow({ id: 'usr_4', createdAt: t3 }),
      ],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const page1 = await svc.list({ limit: 2, now: NOW });
    expect(page1.users.map((u) => u.id)).toEqual(['usr_1', 'usr_2']);
    const cursor = page1.nextCursor;
    expect(cursor).not.toBeNull();

    const page2 = await svc.list({ limit: 2, cursor: cursor!, now: NOW });
    expect(page2.users.map((u) => u.id)).toEqual(['usr_3', 'usr_4']);
    expect(page2.nextCursor).toBeNull();
  });

  it('treats a malformed cursor as "start from the top"', async () => {
    const prisma = buildFakePrisma({
      users: [makeUserRow({ id: 'usr_1' })],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const page = await svc.list({ cursor: 'garbage', limit: 25, now: NOW });
    expect(page.users.map((u) => u.id)).toEqual(['usr_1']);
  });

  it('marks currentlyLocked when lockedUntil is in the future', async () => {
    const futureLock = new Date(NOW.getTime() + 60_000);
    const prisma = buildFakePrisma({
      users: [makeUserRow({ id: 'usr_1', lockedUntil: futureLock })],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.users[0]?.currentlyLocked).toBe(true);
  });

  it('marks currentlyLocked false when lockedUntil is in the past', async () => {
    const pastLock = new Date(NOW.getTime() - 60_000);
    const prisma = buildFakePrisma({
      users: [makeUserRow({ id: 'usr_1', lockedUntil: pastLock })],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const page = await svc.list({ limit: 25, now: NOW });
    expect(page.users[0]?.currentlyLocked).toBe(false);
  });

  it('denormalises activeRoleCount + holdsAdminRole per page', async () => {
    const prisma = buildFakePrisma({
      users: [makeUserRow({ id: 'usr_1' }), makeUserRow({ id: 'usr_2' })],
      userRoles: [
        {
          id: 'ur_1',
          userId: 'usr_1',
          roleId: 'role_family_payer',
          revokedAt: null,
          expiresAt: null,
          scopeType: 'global',
          scopeId: null,
          role: { name: 'family_payer' },
        },
        {
          id: 'ur_2',
          userId: 'usr_1',
          roleId: 'role_super_admin',
          revokedAt: null,
          expiresAt: null,
          scopeType: 'global',
          scopeId: null,
          role: { name: 'super_admin' },
        },
        {
          id: 'ur_3',
          userId: 'usr_2',
          roleId: 'role_family_payer',
          revokedAt: null,
          expiresAt: null,
          scopeType: 'global',
          scopeId: null,
          role: { name: 'family_payer' },
        },
      ],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const page = await svc.list({ limit: 25, now: NOW });
    const u1 = page.users.find((u) => u.id === 'usr_1')!;
    const u2 = page.users.find((u) => u.id === 'usr_2')!;
    expect(u1.activeRoleCount).toBe(2);
    expect(u1.holdsAdminRole).toBe(true);
    expect(u2.activeRoleCount).toBe(1);
    expect(u2.holdsAdminRole).toBe(false);
  });

  it('roleName filter narrows results to users with an active assignment of that role', async () => {
    const prisma = buildFakePrisma({
      users: [
        makeUserRow({ id: 'usr_1' }),
        makeUserRow({ id: 'usr_2' }),
        makeUserRow({ id: 'usr_3' }),
      ],
      userRoles: [
        {
          id: 'ur_1',
          userId: 'usr_1',
          roleId: 'role_finance',
          revokedAt: null,
          expiresAt: null,
          scopeType: 'global',
          scopeId: null,
          role: { name: 'finance' },
        },
        {
          id: 'ur_2',
          userId: 'usr_3',
          roleId: 'role_finance',
          revokedAt: null,
          expiresAt: null,
          scopeType: 'global',
          scopeId: null,
          role: { name: 'finance' },
        },
      ],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const page = await svc.list({ roleName: 'finance', limit: 25, now: NOW });
    expect(page.users.map((u) => u.id).sort()).toEqual(['usr_1', 'usr_3']);
  });

  it('roleName filter excludes revoked / expired assignments', async () => {
    const past = new Date(NOW.getTime() - 60_000);
    const prisma = buildFakePrisma({
      users: [makeUserRow({ id: 'usr_1' }), makeUserRow({ id: 'usr_2' })],
      userRoles: [
        {
          id: 'ur_1',
          userId: 'usr_1',
          roleId: 'role_finance',
          revokedAt: past,
          expiresAt: null,
          scopeType: 'global',
          scopeId: null,
          role: { name: 'finance' },
        },
        {
          id: 'ur_2',
          userId: 'usr_2',
          roleId: 'role_finance',
          revokedAt: null,
          expiresAt: past,
          scopeType: 'global',
          scopeId: null,
          role: { name: 'finance' },
        },
      ],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const page = await svc.list({ roleName: 'finance', limit: 25, now: NOW });
    expect(page.users).toEqual([]);
  });

  it('roleName filter with zero matches returns an empty page immediately', async () => {
    const prisma = buildFakePrisma({
      users: [makeUserRow({ id: 'usr_1' })],
      userRoles: [],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const page = await svc.list({ roleName: 'super_admin', limit: 25, now: NOW });
    expect(page.users).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe('AdminUsersService.getById', () => {
  it('returns null when the user does not exist', async () => {
    const prisma = buildFakePrisma({ users: [] });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const row = await svc.getById({ userId: 'usr_missing', now: NOW });
    expect(row).toBeNull();
  });

  it('hydrates roles, MFA methods, KYC, and lockout from the per-user fetches', async () => {
    const earlier = new Date(NOW.getTime() - 60_000);
    const prisma = buildFakePrisma({
      users: [makeUserRow({ id: 'usr_1', mfaEnabled: true })],
      mfaMethods: [
        {
          id: 'mfa_1',
          userId: 'usr_1',
          kind: 'totp',
          label: 'iPhone Authenticator',
          confirmedAt: earlier,
          deletedAt: null,
          lastUsedAt: NOW,
          createdAt: earlier,
        },
        {
          id: 'mfa_2',
          userId: 'usr_1',
          kind: 'totp',
          label: 'unconfirmed',
          confirmedAt: null,
          deletedAt: null,
          lastUsedAt: null,
          createdAt: NOW,
        },
      ],
      kycRecords: [
        {
          id: 'kyc_1',
          userId: 'usr_1',
          status: 'verified',
          verifiedAt: NOW,
          createdAt: earlier,
          updatedAt: NOW,
        },
      ],
    });
    const roles = buildRoleAssignmentFake({
      usr_1: [makeRoleRecord('family_payer'), makeRoleRecord('super_admin')],
    });
    const svc = new AdminUsersService(prisma, roles);

    const row = await svc.getById({ userId: 'usr_1', now: NOW });
    expect(row).not.toBeNull();
    expect(row!.id).toBe('usr_1');
    expect(row!.roles.map((r) => r.name).sort()).toEqual(['family_payer', 'super_admin']);
    expect(row!.holdsAdminRole).toBe(true);
    // Unconfirmed MFA method should be filtered out.
    expect(row!.mfaMethods.map((m) => m.id)).toEqual(['mfa_1']);
    expect(row!.latestKyc?.status).toBe('verified');
    expect(row!.lockout.currentlyLocked).toBe(false);
  });

  it('reports holdsAdminRole=false when the user holds only non-admin roles', async () => {
    const prisma = buildFakePrisma({ users: [makeUserRow({ id: 'usr_1' })] });
    const roles = buildRoleAssignmentFake({
      usr_1: [makeRoleRecord('family_payer')],
    });
    const svc = new AdminUsersService(prisma, roles);

    const row = await svc.getById({ userId: 'usr_1', now: NOW });
    expect(row?.holdsAdminRole).toBe(false);
  });

  it('returns latestKyc null when the user has never started a KYC session', async () => {
    const prisma = buildFakePrisma({
      users: [makeUserRow({ id: 'usr_1' })],
      kycRecords: [],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const row = await svc.getById({ userId: 'usr_1', now: NOW });
    expect(row?.latestKyc).toBeNull();
  });

  it('selects the most-recent KYC record by createdAt DESC', async () => {
    const older = new Date(NOW.getTime() - 86_400_000);
    const newer = new Date(NOW.getTime() - 60_000);
    const prisma = buildFakePrisma({
      users: [makeUserRow({ id: 'usr_1' })],
      kycRecords: [
        {
          id: 'kyc_old',
          userId: 'usr_1',
          status: 'failed',
          verifiedAt: null,
          createdAt: older,
          updatedAt: older,
        },
        {
          id: 'kyc_new',
          userId: 'usr_1',
          status: 'verified',
          verifiedAt: newer,
          createdAt: newer,
          updatedAt: newer,
        },
      ],
    });
    const svc = new AdminUsersService(prisma, buildRoleAssignmentFake({}));

    const row = await svc.getById({ userId: 'usr_1', now: NOW });
    expect(row?.latestKyc?.id).toBe('kyc_new');
  });
});
