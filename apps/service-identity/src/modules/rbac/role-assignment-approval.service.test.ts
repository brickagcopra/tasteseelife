import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import type { RbacApprovalEmitter } from './rbac-approval-emitter';
import { RoleAssignmentApprovalService } from './role-assignment-approval.service';
import { SENSITIVE_ROLE_NAMES } from './seed-catalog';
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

const NOW = new Date('2026-07-01T12:00:00.000Z');

type ApprovalSeed = {
  id: string;
  userId: string;
  roleId: string;
  scopeType: 'global' | 'tenant' | 'household';
  scopeId: string | null;
  expiresAt: Date | null;
  requestedByUserId: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  approvedByUserId: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  userRoleId: string | null;
  createdAt: Date;
  role: { name: string; archivedAt: Date | null };
};

function approvalSeed(overrides: Partial<ApprovalSeed> = {}): ApprovalSeed {
  const base: ApprovalSeed = {
    id: 'apr_1',
    userId: 'user_1',
    roleId: 'role_fin',
    scopeType: 'global',
    scopeId: null,
    expiresAt: null,
    requestedByUserId: 'admin_1',
    reason: 'quarter close',
    status: 'pending',
    approvedByUserId: null,
    decidedAt: null,
    decisionNote: null,
    userRoleId: null,
    createdAt: NOW,
    role: { name: 'finance', archivedAt: null },
  };
  return { ...base, ...overrides, role: overrides.role ?? base.role };
}

/**
 * In-memory fake covering the slices the flow touches. `$transaction`
 * hands the same fake back as the tx client (the service only relies
 * on rollback via throw, which unit tests assert by observing that no
 * post-throw writes are visible).
 */
function buildFakePrisma(seed: {
  users?: Array<{ id: string; deletedAt?: Date | null }>;
  roles?: Array<{ id: string; name: string; archivedAt?: Date | null }>;
  approvals?: ApprovalSeed[];
  activeUserRoleKeys?: string[];
  userRoleCreate?: () => Promise<{ id: string }>;
  approvalCreate?: (data: Record<string, unknown>) => Promise<ApprovalSeed> | ApprovalSeed;
}) {
  const users = seed.users ?? [];
  const roles = seed.roles ?? [];
  const approvals = new Map((seed.approvals ?? []).map((a) => [a.id, a]));
  const activeKeys = new Set(seed.activeUserRoleKeys ?? []);
  const roleById = new Map(roles.map((r) => [r.id, r]));

  const fake = {
    user: {
      findUnique: vi.fn(async (req: { where: { id: string } }) => {
        const hit = users.find((u) => u.id === req.where.id);
        return hit === undefined ? null : { id: hit.id, deletedAt: hit.deletedAt ?? null };
      }),
    },
    role: {
      findUnique: vi.fn(async (req: { where: { name: string } }) => {
        const hit = roles.find((r) => r.name === req.where.name);
        return hit === undefined
          ? null
          : { id: hit.id, name: hit.name, archivedAt: hit.archivedAt ?? null };
      }),
    },
    userRole: {
      findFirst: vi.fn(
        async (req: {
          where: { userId: string; roleId: string; scopeType: string; scopeId: string | null };
        }) => {
          const key = `${req.where.userId} ${req.where.roleId} ${req.where.scopeType} ${req.where.scopeId ?? ''}`;
          return activeKeys.has(key) ? { id: 'ur_existing' } : null;
        },
      ),
      create: vi.fn(async () => {
        if (seed.userRoleCreate !== undefined) return seed.userRoleCreate();
        return { id: 'ur_minted' };
      }),
    },
    roleAssignmentApproval: {
      create: vi.fn(async (req: { data: Record<string, unknown> }) => {
        if (seed.approvalCreate !== undefined) return seed.approvalCreate(req.data);
        const roleId = req.data.roleId as string;
        const created = approvalSeed({
          id: 'apr_new',
          userId: req.data.userId as string,
          roleId,
          scopeType: (req.data.scopeType as ApprovalSeed['scopeType']) ?? 'global',
          scopeId: (req.data.scopeId as string | null) ?? null,
          expiresAt: (req.data.expiresAt as Date | null) ?? null,
          requestedByUserId: req.data.requestedByUserId as string,
          reason: (req.data.reason as string) ?? null,
          role: {
            name: roleById.get(roleId)?.name ?? 'unknown',
            archivedAt: roleById.get(roleId)?.archivedAt ?? null,
          },
        });
        approvals.set(created.id, created);
        return created;
      }),
      findUnique: vi.fn(async (req: { where: { id: string } }) => {
        return approvals.get(req.where.id) ?? null;
      }),
      findMany: vi.fn(async (req: { where?: { status?: string } }) =>
        [...approvals.values()].filter(
          (a) => req.where?.status === undefined || a.status === req.where.status,
        ),
      ),
      update: vi.fn(async (req: { where: { id: string }; data: Record<string, unknown> }) => {
        const current = approvals.get(req.where.id);
        if (current === undefined) throw new Error('update on unknown approval');
        const next = { ...current, ...req.data } as ApprovalSeed;
        approvals.set(next.id, next);
        return next;
      }),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(fake)),
  };
  return { fake: fake as unknown as PrismaService, approvals, raw: fake };
}

function buildEmitter() {
  return {
    emitRequested: vi.fn(async () => undefined),
    emitDecided: vi.fn(async () => undefined),
  } as unknown as RbacApprovalEmitter & {
    emitRequested: ReturnType<typeof vi.fn>;
    emitDecided: ReturnType<typeof vi.fn>;
  };
}

const SUPER = ['super_admin', 'operations_manager'];
const NOT_SUPER = ['operations_manager'];

describe('RoleAssignmentApprovalService.requestGrant', () => {
  const seedBase = {
    users: [{ id: 'user_1' }],
    roles: [{ id: 'role_fin', name: 'finance' }],
  };

  it('creates a pending request and emits the requested event in-tx', async () => {
    const { fake, raw } = buildFakePrisma(seedBase);
    const emitter = buildEmitter();
    const service = new RoleAssignmentApprovalService(fake, emitter, fakeAudit());

    const record = await service.requestGrant({
      userId: 'user_1',
      roleName: 'finance',
      scope: { type: 'global' },
      reason: 'quarter close',
      actor: actorCtx('admin_1'),
    });

    expect(record.status).toBe('pending');
    expect(record.requestedByUserId).toBe('admin_1');
    expect(record.roleName).toBe('finance');
    expect(emitter.emitRequested).toHaveBeenCalledTimes(1);
    expect(emitter.emitRequested.mock.calls[0]?.[1]).toMatchObject({
      userId: 'user_1',
      roleName: 'finance',
      requestedByUserId: 'admin_1',
    });
    expect(raw.$transaction).toHaveBeenCalledTimes(1);
  });

  it('400s a NON-sensitive role — the direct grant surface owns those', async () => {
    const { fake } = buildFakePrisma({
      users: [{ id: 'user_1' }],
      roles: [{ id: 'role_cs', name: 'customer_support' }],
    });
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());

    await expect(
      service.requestGrant({
        userId: 'user_1',
        roleName: 'customer_support',
        scope: { type: 'global' },
        reason: 'why',
        actor: actorCtx('admin_1'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([...SENSITIVE_ROLE_NAMES])('accepts each sensitive role (%s)', async (roleName) => {
    const { fake } = buildFakePrisma({
      users: [{ id: 'user_1' }],
      roles: [{ id: `role_${roleName}`, name: roleName }],
    });
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());
    const record = await service.requestGrant({
      userId: 'user_1',
      roleName,
      scope: { type: 'global' },
      reason: 'why',
      actor: actorCtx('admin_1'),
    });
    expect(record.status).toBe('pending');
  });

  it('404s an unknown role and 409s an archived one', async () => {
    const { fake } = buildFakePrisma({
      users: [{ id: 'user_1' }],
      roles: [{ id: 'role_fin', name: 'finance', archivedAt: NOW }],
    });
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());

    await expect(
      service.requestGrant({
        userId: 'user_1',
        roleName: 'ghost',
        scope: { type: 'global' },
        reason: 'why',
        actor: actorCtx('admin_1'),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.requestGrant({
        userId: 'user_1',
        roleName: 'finance',
        scope: { type: 'global' },
        reason: 'why',
        actor: actorCtx('admin_1'),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('404s an unknown or soft-deleted grantee', async () => {
    const { fake } = buildFakePrisma({
      users: [{ id: 'user_gone', deletedAt: NOW }],
      roles: [{ id: 'role_fin', name: 'finance' }],
    });
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());
    for (const userId of ['user_gone', 'user_missing']) {
      await expect(
        service.requestGrant({
          userId,
          roleName: 'finance',
          scope: { type: 'global' },
          reason: 'why',
          actor: actorCtx('admin_1'),
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('400s a past expiry', async () => {
    const { fake } = buildFakePrisma(seedBase);
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());
    await expect(
      service.requestGrant({
        userId: 'user_1',
        roleName: 'finance',
        scope: { type: 'global' },
        expiresAt: '2020-01-01T00:00:00.000Z',
        reason: 'why',
        actor: actorCtx('admin_1'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('409s when the grantee already holds the role actively in that scope — nothing to approve', async () => {
    const { fake, raw } = buildFakePrisma({
      ...seedBase,
      activeUserRoleKeys: ['user_1 role_fin global '],
    });
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());
    await expect(
      service.requestGrant({
        userId: 'user_1',
        roleName: 'finance',
        scope: { type: 'global' },
        reason: 'why',
        actor: actorCtx('admin_1'),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(raw.roleAssignmentApproval.create).not.toHaveBeenCalled();
  });

  it('translates the duplicate-pending P2002 into a 409', async () => {
    const { fake } = buildFakePrisma({
      ...seedBase,
      approvalCreate: () => {
        const err = new Error('unique') as Error & { code: string };
        err.code = 'P2002';
        throw err;
      },
    });
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());
    await expect(
      service.requestGrant({
        userId: 'user_1',
        roleName: 'finance',
        scope: { type: 'global' },
        reason: 'why',
        actor: actorCtx('admin_1'),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('RoleAssignmentApprovalService.approve', () => {
  it('mints the grant, marks the row approved with BOTH ids, and emits decided', async () => {
    const { fake, raw, approvals } = buildFakePrisma({
      approvals: [approvalSeed({ role: { name: 'finance', archivedAt: null } })],
    });
    const emitter = buildEmitter();
    const service = new RoleAssignmentApprovalService(fake, emitter, fakeAudit());

    const record = await service.approve({
      approvalId: 'apr_1',
      actor: actorCtx('admin_2'),
      actorRoleNames: SUPER,
      note: 'verified with requester',
    });

    expect(raw.userRole.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user_1',
          roleId: 'role_fin',
          grantedByUserId: 'admin_2',
        }),
      }),
    );
    expect(record.status).toBe('approved');
    expect(record.approvedByUserId).toBe('admin_2');
    expect(record.requestedByUserId).toBe('admin_1');
    expect(record.userRoleId).toBe('ur_minted');
    expect(record.decisionNote).toBe('verified with requester');
    expect(approvals.get('apr_1')?.status).toBe('approved');
    expect(emitter.emitDecided).toHaveBeenCalledTimes(1);
    expect(emitter.emitDecided.mock.calls[0]?.[1]).toMatchObject({
      status: 'approved',
      decidedByUserId: 'admin_2',
      requestedByUserId: 'admin_1',
      userRoleId: 'ur_minted',
    });
  });

  it('403s SELF-approval — the second-admin invariant', async () => {
    const { fake, raw } = buildFakePrisma({ approvals: [approvalSeed()] });
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());

    await expect(
      service.approve({ approvalId: 'apr_1', actor: actorCtx('admin_1'), actorRoleNames: SUPER }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(raw.userRole.create).not.toHaveBeenCalled();
  });

  it('403s an approver without an active super_admin assignment — rbac:write alone is not enough', async () => {
    const { fake, raw } = buildFakePrisma({ approvals: [approvalSeed()] });
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());

    await expect(
      service.approve({
        approvalId: 'apr_1',
        actor: actorCtx('admin_2'),
        actorRoleNames: NOT_SUPER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(raw.userRole.create).not.toHaveBeenCalled();
  });

  it('404s an unknown approval and 409s a non-pending one', async () => {
    const { fake } = buildFakePrisma({
      approvals: [approvalSeed({ id: 'apr_done', status: 'rejected' })],
    });
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());

    await expect(
      service.approve({
        approvalId: 'apr_missing',
        actor: actorCtx('admin_2'),
        actorRoleNames: SUPER,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.approve({
        approvalId: 'apr_done',
        actor: actorCtx('admin_2'),
        actorRoleNames: SUPER,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('terminal-rejects on a concurrent-grant P2002 instead of leaving the row pending', async () => {
    const { fake, approvals } = buildFakePrisma({
      approvals: [approvalSeed()],
      userRoleCreate: () => {
        const err = new Error('unique') as Error & { code: string };
        err.code = 'P2002';
        throw err;
      },
    });
    const emitter = buildEmitter();
    const service = new RoleAssignmentApprovalService(fake, emitter, fakeAudit());

    await expect(
      service.approve({ approvalId: 'apr_1', actor: actorCtx('admin_2'), actorRoleNames: SUPER }),
    ).rejects.toBeInstanceOf(ConflictException);

    const row = approvals.get('apr_1');
    expect(row?.status).toBe('rejected');
    expect(row?.decisionNote).toContain('superseded');
    expect(row?.approvedByUserId).toBe('admin_2');
    expect(emitter.emitDecided).toHaveBeenCalledTimes(1);
    expect(emitter.emitDecided.mock.calls[0]?.[1]).toMatchObject({
      status: 'rejected',
      userRoleId: null,
    });
  });

  it('terminal-rejects when the role was archived after the request', async () => {
    const { fake, approvals } = buildFakePrisma({
      approvals: [approvalSeed({ role: { name: 'finance', archivedAt: NOW } })],
    });
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());

    await expect(
      service.approve({ approvalId: 'apr_1', actor: actorCtx('admin_2'), actorRoleNames: SUPER }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(approvals.get('apr_1')?.status).toBe('rejected');
    expect(approvals.get('apr_1')?.decisionNote).toContain('archived');
  });
});

describe('RoleAssignmentApprovalService.reject', () => {
  it('lets a super_admin reviewer reject with a note (decider recorded)', async () => {
    const { fake, approvals } = buildFakePrisma({ approvals: [approvalSeed()] });
    const emitter = buildEmitter();
    const service = new RoleAssignmentApprovalService(fake, emitter, fakeAudit());

    const record = await service.reject({
      approvalId: 'apr_1',
      actor: actorCtx('admin_2'),
      actorRoleNames: SUPER,
      note: 'insufficient justification',
    });

    expect(record.status).toBe('rejected');
    expect(record.approvedByUserId).toBe('admin_2');
    expect(record.decisionNote).toBe('insufficient justification');
    expect(approvals.get('apr_1')?.status).toBe('rejected');
    expect(emitter.emitDecided.mock.calls[0]?.[1]).toMatchObject({
      status: 'rejected',
      decidedByUserId: 'admin_2',
    });
  });

  it('lets the REQUESTER self-cancel without super_admin', async () => {
    const { fake, approvals } = buildFakePrisma({ approvals: [approvalSeed()] });
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());

    const record = await service.reject({
      approvalId: 'apr_1',
      actor: actorCtx('admin_1'),
      actorRoleNames: NOT_SUPER,
    });
    expect(record.status).toBe('rejected');
    expect(approvals.get('apr_1')?.approvedByUserId).toBe('admin_1');
  });

  it('403s a non-requester without super_admin', async () => {
    const { fake } = buildFakePrisma({ approvals: [approvalSeed()] });
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());
    await expect(
      service.reject({
        approvalId: 'apr_1',
        actor: actorCtx('admin_3'),
        actorRoleNames: NOT_SUPER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('409s a non-pending row', async () => {
    const { fake } = buildFakePrisma({
      approvals: [approvalSeed({ status: 'approved' })],
    });
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());
    await expect(
      service.reject({ approvalId: 'apr_1', actor: actorCtx('admin_2'), actorRoleNames: SUPER }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('RoleAssignmentApprovalService.list', () => {
  it('filters by status and projects wire records', async () => {
    const { fake } = buildFakePrisma({
      approvals: [
        approvalSeed(),
        approvalSeed({ id: 'apr_2', status: 'approved', userRoleId: 'ur_9' }),
      ],
    });
    const service = new RoleAssignmentApprovalService(fake, buildEmitter(), fakeAudit());

    const pending = await service.list({ status: 'pending' });
    expect(pending.map((a) => a.id)).toEqual(['apr_1']);
    expect(pending[0]?.scope).toEqual({ type: 'global' });

    const all = await service.list();
    expect(all).toHaveLength(2);
  });
});
