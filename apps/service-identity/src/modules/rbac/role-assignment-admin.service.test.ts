import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ADMIN_ROLE_ASSIGNMENTS_SENSITIVE_ROLES } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { RoleAssignmentAdminService } from './role-assignment-admin.service';
import type { RoleAssignmentRecord, RoleAssignmentService } from './role-assignment.service';
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
const FUTURE = new Date('2027-01-01T00:00:00.000Z');

function record(overrides: Partial<RoleAssignmentRecord> = {}): RoleAssignmentRecord {
  return {
    id: 'ur_1',
    userId: 'user_1',
    assignment: {
      name: 'customer_support',
      scope: { type: 'global' },
      permissions: ['user:read'],
    },
    active: true,
    grantedByUserId: 'admin_1',
    createdAt: NOW,
    revokedAt: null,
    ...overrides,
  };
}

/**
 * Fake prisma slice: `user` (existence checks + bulk lookup), `role`
 * (bulk lookup), `userRole` (revoke existence check). The assignment
 * WRITES go through the faked `RoleAssignmentService`, not prisma —
 * this service is a policy layer.
 */
function buildFakePrisma(seed: {
  users?: Array<{ id: string; deletedAt?: Date | null }>;
  roles?: Array<{ name: string; archivedAt?: Date | null }>;
  userRoleIds?: string[];
}): PrismaService {
  const users = seed.users ?? [];
  const roles = seed.roles ?? [];
  const userRoleIds = new Set(seed.userRoleIds ?? []);
  const fake = {
    user: {
      findUnique: vi.fn(async (req: { where: { id: string } }) => {
        const hit = users.find((u) => u.id === req.where.id);
        return hit === undefined ? null : { id: hit.id, deletedAt: hit.deletedAt ?? null };
      }),
      findMany: vi.fn(async (req: { where: { id: { in: string[] } } }) =>
        users
          .filter((u) => req.where.id.in.includes(u.id))
          .map((u) => ({ id: u.id, deletedAt: u.deletedAt ?? null })),
      ),
    },
    role: {
      findMany: vi.fn(async (req: { where: { name: { in: string[] } } }) =>
        roles
          .filter((r) => req.where.name.in.includes(r.name))
          .map((r) => ({ name: r.name, archivedAt: r.archivedAt ?? null })),
      ),
    },
    userRole: {
      // The revoke path reads the row facts for the audit snapshot —
      // the fake returns the full selected shape, not a bare id.
      findUnique: vi.fn(async (req: { where: { id: string } }) =>
        userRoleIds.has(req.where.id)
          ? {
              id: req.where.id,
              userId: 'user_1',
              scopeType: 'global',
              scopeId: null,
              expiresAt: null,
              role: { name: 'customer_support' },
            }
          : null,
      ),
    },
    // Interactive-transaction fake — runs the callback against the fake
    // itself (atomicity is the DB's concern; these tests assert
    // orchestration). The TS-295 write+audit pairs run through this.
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(fake)),
  };
  return fake as unknown as PrismaService;
}

function buildAssignments(
  overrides: Partial<{
    grant: RoleAssignmentService['grant'];
    revoke: RoleAssignmentService['revoke'];
    listForUser: RoleAssignmentService['listForUser'];
  }> = {},
): RoleAssignmentService {
  return {
    grant:
      overrides.grant ??
      (vi.fn(async () => ({ id: 'ur_1' })) as unknown as RoleAssignmentService['grant']),
    revoke:
      overrides.revoke ??
      (vi.fn(async () => ({ revoked: true })) as unknown as RoleAssignmentService['revoke']),
    listForUser:
      overrides.listForUser ??
      (vi.fn(async () => [record()]) as unknown as RoleAssignmentService['listForUser']),
  } as unknown as RoleAssignmentService;
}

/** Construct the service under test with the audit emitter stubbed. */
function buildService(
  prisma: PrismaService,
  assignments: RoleAssignmentService,
  audit: AuditEmitter = fakeAudit(),
): RoleAssignmentAdminService {
  return new RoleAssignmentAdminService(prisma, assignments, audit);
}

describe('sensitive-role list drift guard', () => {
  it('seed-catalog SENSITIVE_ROLE_NAMES matches the contracts mirror', () => {
    // The catalog is authoritative; the contracts const exists so
    // web-admin can hide the affordance. They must never drift.
    expect([...SENSITIVE_ROLE_NAMES]).toEqual([...ADMIN_ROLE_ASSIGNMENTS_SENSITIVE_ROLES]);
  });
});

describe('RoleAssignmentAdminService.grantSingle', () => {
  it('grants via the assignment service with the actor as grantor and returns the wire record', async () => {
    const grant = vi.fn(async () => ({ id: 'ur_1' }));
    const service = buildService(
      buildFakePrisma({ users: [{ id: 'user_1' }] }),
      buildAssignments({ grant: grant as unknown as RoleAssignmentService['grant'] }),
    );

    const result = await service.grantSingle({
      userId: 'user_1',
      roleName: 'customer_support',
      scope: { type: 'global' },
      actor: actorCtx('admin_1'),
    });

    expect(grant).toHaveBeenCalledWith(
      {
        userId: 'user_1',
        roleName: 'customer_support',
        scope: { type: 'global' },
        grantedByUserId: 'admin_1',
      },
      // The grant runs inside the audit transaction (TS-295) — the tx
      // client rides along.
      expect.anything(),
    );
    expect(result).toEqual({
      id: 'ur_1',
      userId: 'user_1',
      roleName: 'customer_support',
      scope: { type: 'global' },
      active: true,
      grantedByUserId: 'admin_1',
      expiresAt: null,
      revokedAt: null,
      createdAt: NOW.toISOString(),
    });
  });

  it.each([...SENSITIVE_ROLE_NAMES])(
    '403s a sensitive-role grant (%s) without touching the DB',
    async (roleName) => {
      const grant = vi.fn(async () => ({ id: 'ur_x' }));
      const prisma = buildFakePrisma({ users: [{ id: 'user_1' }] });
      const service = buildService(
        prisma,
        buildAssignments({ grant: grant as unknown as RoleAssignmentService['grant'] }),
      );

      await expect(
        service.grantSingle({
          userId: 'user_1',
          roleName,
          scope: { type: 'global' },
          actor: actorCtx('admin_1'),
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(grant).not.toHaveBeenCalled();
    },
  );

  it('404s for an unknown or soft-deleted user', async () => {
    const service = buildService(
      buildFakePrisma({ users: [{ id: 'user_gone', deletedAt: NOW }] }),
      buildAssignments(),
    );

    await expect(
      service.grantSingle({
        userId: 'user_missing',
        roleName: 'customer_support',
        scope: { type: 'global' },
        actor: actorCtx('admin_1'),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.grantSingle({
        userId: 'user_gone',
        roleName: 'customer_support',
        scope: { type: 'global' },
        actor: actorCtx('admin_1'),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400s a past expiresAt', async () => {
    const service = buildService(
      buildFakePrisma({ users: [{ id: 'user_1' }] }),
      buildAssignments(),
    );

    await expect(
      service.grantSingle({
        userId: 'user_1',
        roleName: 'customer_support',
        scope: { type: 'global' },
        expiresAt: '2020-01-01T00:00:00.000Z',
        actor: actorCtx('admin_1'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('propagates the duplicate-active 409 from the assignment service', async () => {
    const grant = vi.fn(async () => {
      throw new ConflictException({ detail: 'duplicate' });
    });
    const service = buildService(
      buildFakePrisma({ users: [{ id: 'user_1' }] }),
      buildAssignments({ grant: grant as unknown as RoleAssignmentService['grant'] }),
    );

    await expect(
      service.grantSingle({
        userId: 'user_1',
        roleName: 'customer_support',
        scope: { type: 'global' },
        actor: actorCtx('admin_1'),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('RoleAssignmentAdminService.revoke', () => {
  it('404s an unknown assignment id', async () => {
    const service = buildService(buildFakePrisma({}), buildAssignments(), fakeAudit());
    await expect(
      service.revoke({ assignmentId: 'ur_missing', actor: actorCtx('admin_1') }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('delegates to the assignment service and surfaces the idempotent flag', async () => {
    const revoke = vi.fn(async () => ({ revoked: false }));
    const service = buildService(
      buildFakePrisma({ userRoleIds: ['ur_1'] }),
      buildAssignments({ revoke: revoke as unknown as RoleAssignmentService['revoke'] }),
    );

    const result = await service.revoke({ assignmentId: 'ur_1', actor: actorCtx('admin_1') });
    expect(revoke).toHaveBeenCalledWith(
      { assignmentId: 'ur_1', revokedByUserId: 'admin_1' },
      expect.anything(),
    );
    expect(result).toEqual({ revoked: false });
  });
});

describe('RoleAssignmentAdminService.listForUser', () => {
  it('404s an unknown user and projects records for a live one', async () => {
    const service = buildService(
      buildFakePrisma({ users: [{ id: 'user_1' }] }),
      buildAssignments({
        listForUser: vi.fn(async () => [
          record({ revokedAt: NOW, active: false }),
        ]) as unknown as RoleAssignmentService['listForUser'],
      }),
    );

    await expect(service.listForUser('user_missing')).rejects.toBeInstanceOf(NotFoundException);

    const list = await service.listForUser('user_1', { includeInactive: true });
    expect(list).toHaveLength(1);
    expect(list[0]?.revokedAt).toBe(NOW.toISOString());
    expect(list[0]?.active).toBe(false);
  });
});

const VALID_ROW = {
  userId: 'user_1',
  roleName: 'customer_support',
  scopeType: 'global',
  scopeId: null,
  expiresAt: null,
};

function buildPreviewService(): RoleAssignmentAdminService {
  return buildService(
    buildFakePrisma({
      users: [{ id: 'user_1' }, { id: 'user_2' }, { id: 'user_deleted', deletedAt: NOW }],
      roles: [
        { name: 'customer_support' },
        { name: 'marketing' },
        { name: 'old_role', archivedAt: NOW },
      ],
    }),
    buildAssignments(),
  );
}

describe('RoleAssignmentAdminService.bulkPreview', () => {
  it('marks a fully valid row ok with its normalized grant', async () => {
    const verdicts = await buildPreviewService().bulkPreview([
      { ...VALID_ROW, expiresAt: FUTURE.toISOString() },
    ]);
    expect(verdicts).toEqual([
      {
        index: 0,
        ok: true,
        errors: [],
        normalized: {
          userId: 'user_1',
          roleName: 'customer_support',
          scope: { type: 'global' },
          expiresAt: FUTURE.toISOString(),
        },
      },
    ]);
  });

  it('normalizes tenant / household scopes from the flat CSV pair', async () => {
    const verdicts = await buildPreviewService().bulkPreview([
      { ...VALID_ROW, scopeType: 'tenant', scopeId: 'tenant_9' },
      { ...VALID_ROW, userId: 'user_2', scopeType: 'household', scopeId: 'hh_3' },
    ]);
    expect(verdicts[0]?.normalized?.scope).toEqual({ type: 'tenant', tenantId: 'tenant_9' });
    expect(verdicts[1]?.normalized?.scope).toEqual({ type: 'household', householdId: 'hh_3' });
  });

  it.each([
    [{ ...VALID_ROW, scopeType: 'galaxy' }, 'scopeType'],
    [{ ...VALID_ROW, scopeId: 'extra' }, 'scopeId'],
    [{ ...VALID_ROW, scopeType: 'tenant' }, 'scopeId'],
    [{ ...VALID_ROW, expiresAt: 'not-a-date' }, 'expiresAt'],
    [{ ...VALID_ROW, expiresAt: '2020-01-01T00:00:00.000Z' }, 'expiresAt'],
    [{ ...VALID_ROW, userId: 'user_missing' }, 'userId'],
    [{ ...VALID_ROW, userId: 'user_deleted' }, 'userId'],
    [{ ...VALID_ROW, roleName: 'no_such_role' }, 'roleName'],
    [{ ...VALID_ROW, roleName: 'old_role' }, 'roleName'],
    [{ ...VALID_ROW, roleName: 'finance' }, 'roleName'],
  ] as const)('rejects row %# naming the offending field', async (row, field) => {
    const verdicts = await buildPreviewService().bulkPreview([row]);
    expect(verdicts[0]?.ok).toBe(false);
    expect(verdicts[0]?.normalized).toBeNull();
    expect(verdicts[0]?.errors.map((e) => e.field)).toContain(field);
  });

  it('flags an exact duplicate of an earlier row in the file', async () => {
    const verdicts = await buildPreviewService().bulkPreview([VALID_ROW, { ...VALID_ROW }]);
    expect(verdicts[0]?.ok).toBe(true);
    expect(verdicts[1]?.ok).toBe(false);
    expect(verdicts[1]?.errors).toEqual([
      { field: 'row', message: 'duplicate of an earlier row in this file' },
    ]);
  });
});

describe('RoleAssignmentAdminService.bulkCommit', () => {
  it('applies rows with partial-success semantics: granted, conflict, error', async () => {
    let call = 0;
    const grant = vi.fn(async () => {
      call += 1;
      if (call === 2) {
        throw new ConflictException({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'User already holds an active assignment.',
        });
      }
      return { id: `ur_${call}` };
    });
    const service = buildService(
      buildFakePrisma({
        users: [{ id: 'user_1' }, { id: 'user_2' }],
        roles: [{ name: 'customer_support' }, { name: 'marketing' }],
      }),
      buildAssignments({ grant: grant as unknown as RoleAssignmentService['grant'] }),
    );

    const outcomes = await service.bulkCommit(
      [VALID_ROW, { ...VALID_ROW, userId: 'user_2' }, { ...VALID_ROW, userId: 'user_missing' }],
      actorCtx('admin_1'),
    );

    expect(outcomes).toEqual([
      { index: 0, status: 'granted', assignmentId: 'ur_1', message: null },
      {
        index: 1,
        status: 'conflict',
        assignmentId: null,
        message: 'User already holds an active assignment.',
      },
      {
        index: 2,
        status: 'error',
        assignmentId: null,
        message: 'userId: no live user with this id',
      },
    ]);
    // The invalid row never reached the grant path.
    expect(grant).toHaveBeenCalledTimes(2);
    // Grants carry the actor as grantor.
    expect(grant).toHaveBeenCalledWith(
      expect.objectContaining({ grantedByUserId: 'admin_1' }),
      expect.anything(),
    );
  });

  it('maps a non-HTTP grant failure to a generic per-row error without failing the batch', async () => {
    const grant = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const service = buildService(
      buildFakePrisma({
        users: [{ id: 'user_1' }],
        roles: [{ name: 'customer_support' }],
      }),
      buildAssignments({ grant: grant as unknown as RoleAssignmentService['grant'] }),
    );

    const outcomes = await service.bulkCommit([VALID_ROW], actorCtx('admin_1'));
    expect(outcomes).toEqual([
      {
        index: 0,
        status: 'error',
        assignmentId: null,
        message: 'internal error applying this row',
      },
    ]);
  });
});
