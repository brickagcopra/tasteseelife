import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuthService } from '../../auth/services/auth.service';
import type { RoleAssignmentService } from '../../rbac/role-assignment.service';
import { AdminImpersonationService } from './admin-impersonation.service';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { AuditEmitter } from '@taste-and-see/nest-audit';

const OPERATOR = 'usr_operator';
const TARGET = 'usr_target';

function actorCtx(actorUserId = OPERATOR): AuditActorContext {
  return {
    actorUserId,
    actorRole: 'super_admin',
    actorTenantScopeType: 'global',
    actorTenantScopeId: null,
    ip: '203.0.113.9',
    userAgent: 'vitest',
    requestId: 'req_1',
    traceId: null,
  };
}

interface FakeUserRow {
  id: string;
  email: string;
  status: 'pending_verification' | 'active' | 'suspended' | 'deactivated';
  deletedAt: Date | null;
}

interface FakeSessionRow {
  familyId: string;
  userId: string;
  impersonatorUserId: string | null;
  revokedAt: Date | null;
}

/**
 * In-memory fake of the Prisma slice the service touches: `users`
 * reads, `refresh_tokens` family reads + revocation, and the
 * `$transaction(callback)` surface (the callback runs against the fake
 * itself — atomicity is the DB's job; these tests assert
 * orchestration, refusal rules, and audit wiring).
 */
function buildFakePrisma(args: { users?: FakeUserRow[]; sessions?: FakeSessionRow[] }): {
  prisma: PrismaService;
  sessions: FakeSessionRow[];
} {
  const users = args.users ?? [];
  const sessions = args.sessions ?? [];

  const prisma = {
    user: {
      findFirst: vi.fn(
        async (req: { where: { id: string; deletedAt: null } }) =>
          users.find((u) => u.id === req.where.id && u.deletedAt === null) ?? null,
      ),
    },
    refreshToken: {
      findFirst: vi.fn(
        async (req: { where: { familyId: string } }) =>
          sessions.find((s) => s.familyId === req.where.familyId) ?? null,
      ),
      updateMany: vi.fn(
        async (req: {
          where: { familyId: string; revokedAt: null };
          data: { revokedAt: Date };
        }) => {
          let count = 0;
          for (const s of sessions) {
            if (s.familyId === req.where.familyId && s.revokedAt === null) {
              s.revokedAt = req.data.revokedAt;
              count += 1;
            }
          }
          return { count };
        },
      ),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      return callback(prisma);
    }),
  } as unknown as PrismaService;

  return { prisma, sessions };
}

function buildAuth(): { auth: AuthService; issueSessionFor: ReturnType<typeof vi.fn> } {
  const issueSessionFor = vi.fn(async () => ({
    outcome: 'session' as const,
    response: {
      outcome: 'session' as const,
      accessToken: 'access.jwt',
      tokenType: 'Bearer' as const,
      expiresIn: 900,
      user: { id: TARGET, email: 'target@example.com', status: 'active' as const },
    },
    refreshToken: 'raw-refresh',
    refreshExpiresAt: new Date('2026-07-02T13:00:00.000Z'),
    sessionFamilyId: 'fam_imp_1',
  }));
  return { auth: { issueSessionFor } as unknown as AuthService, issueSessionFor };
}

function buildRoles(names: string[] = []): RoleAssignmentService {
  return {
    getActiveAssignments: vi.fn(async () =>
      names.map((name) => ({ name, scope: { type: 'global' as const }, permissions: [] })),
    ),
  } as unknown as RoleAssignmentService;
}

function buildEmitter(): { emitter: AuditEmitter; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn(async () => undefined);
  return { emitter: { emit } as unknown as AuditEmitter, emit };
}

const ENV = { IMPERSONATION_SESSION_TTL_SECONDS: 3_600 };

function activeTarget(overrides: Partial<FakeUserRow> = {}): FakeUserRow {
  return {
    id: TARGET,
    email: 'target@example.com',
    status: 'active',
    deletedAt: null,
    ...overrides,
  };
}

function build(
  args: { users?: FakeUserRow[]; sessions?: FakeSessionRow[]; targetRoles?: string[] } = {},
) {
  const { prisma, sessions } = buildFakePrisma({
    ...(args.users !== undefined ? { users: args.users } : {}),
    ...(args.sessions !== undefined ? { sessions: args.sessions } : {}),
  });
  const { auth, issueSessionFor } = buildAuth();
  const { emitter, emit } = buildEmitter();
  const service = new AdminImpersonationService(
    prisma,
    auth,
    buildRoles(args.targetRoles ?? []),
    emitter,
    ENV,
  );
  return { service, issueSessionFor, emit, sessions };
}

describe('AdminImpersonationService.start', () => {
  it('refuses an unknown or soft-deleted target', async () => {
    const { service, issueSessionFor } = build({ users: [] });
    const result = await service.start({
      targetUserId: TARGET,
      reason: 'diagnose booking failure',
      actor: actorCtx(),
      operatorMfaVerified: true,
    });
    expect(result).toEqual({ ok: false, failure: { kind: 'target_not_found' } });
    expect(issueSessionFor).not.toHaveBeenCalled();
  });

  it('refuses self-impersonation', async () => {
    const { service, issueSessionFor } = build({
      users: [activeTarget({ id: OPERATOR, email: 'op@example.com' })],
    });
    const result = await service.start({
      targetUserId: OPERATOR,
      reason: 'testing',
      actor: actorCtx(),
      operatorMfaVerified: true,
    });
    expect(result).toEqual({ ok: false, failure: { kind: 'self' } });
    expect(issueSessionFor).not.toHaveBeenCalled();
  });

  it('refuses targets holding an admin-staff role (privilege laundering)', async () => {
    const { service, issueSessionFor, emit } = build({
      users: [activeTarget()],
      targetRoles: ['operations_manager'],
    });
    const result = await service.start({
      targetUserId: TARGET,
      reason: 'testing',
      actor: actorCtx(),
      operatorMfaVerified: true,
    });
    expect(result).toEqual({ ok: false, failure: { kind: 'admin_target' } });
    expect(issueSessionFor).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses deactivated targets', async () => {
    const { service } = build({ users: [activeTarget({ status: 'deactivated' })] });
    const result = await service.start({
      targetUserId: TARGET,
      reason: 'testing',
      actor: actorCtx(),
      operatorMfaVerified: true,
    });
    expect(result).toEqual({ ok: false, failure: { kind: 'deactivated' } });
  });

  it('mints through issueSessionFor with the impersonation marker and audits atomically', async () => {
    const { service, issueSessionFor, emit } = build({ users: [activeTarget()] });
    const before = Date.now();

    const result = await service.start({
      targetUserId: TARGET,
      reason: 'diagnose failed checkout',
      actor: actorCtx(),
      operatorMfaVerified: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.accessToken).toBe('access.jwt');
    expect(result.value.refreshToken).toBe('raw-refresh');
    expect(result.value.sessionFamilyId).toBe('fam_imp_1');
    expect(result.value.operatorUserId).toBe(OPERATOR);
    expect(result.value.user).toEqual({
      id: TARGET,
      email: 'target@example.com',
      status: 'active',
    });

    expect(issueSessionFor).toHaveBeenCalledTimes(1);
    const args = issueSessionFor.mock.calls[0]?.[0] as {
      userId: string;
      mfaVerified: boolean;
      ssoAsserted: boolean;
      impersonation: { operatorUserId: string; sessionExpiresAt: Date; tx: unknown };
    };
    expect(args.userId).toBe(TARGET);
    // MFA is inherited from the OPERATOR — the target never authenticated.
    expect(args.mfaVerified).toBe(true);
    expect(args.ssoAsserted).toBe(false);
    expect(args.impersonation.operatorUserId).toBe(OPERATOR);
    expect(args.impersonation.tx).toBeDefined();
    const ttlMs = args.impersonation.sessionExpiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThan(3_599_000);
    expect(ttlMs).toBeLessThan(3_700_000);

    expect(emit).toHaveBeenCalledTimes(1);
    const [, actor, descriptor] = emit.mock.calls[0] as [
      unknown,
      AuditActorContext,
      { action: string; resourceKind: string; resourceId: string; after: Record<string, unknown> },
    ];
    expect(actor.actorUserId).toBe(OPERATOR);
    expect(descriptor.action).toBe('user_impersonation:start');
    expect(descriptor.resourceKind).toBe('user_impersonation');
    expect(descriptor.resourceId).toBe(TARGET);
    expect(descriptor.after['operatorUserId']).toBe(OPERATOR);
    expect(descriptor.after['impersonatedUserId']).toBe(TARGET);
    expect(descriptor.after['sessionFamilyId']).toBe('fam_imp_1');
    expect(descriptor.after['reason']).toBe('diagnose failed checkout');
  });

  it('allows suspended targets (support diagnoses suspended accounts)', async () => {
    const { service } = build({ users: [activeTarget({ status: 'suspended' })] });
    const result = await service.start({
      targetUserId: TARGET,
      reason: 'why was this account suspended',
      actor: actorCtx(),
      operatorMfaVerified: true,
    });
    expect(result.ok).toBe(true);
  });
});

describe('AdminImpersonationService.end', () => {
  it('404s an unknown family', async () => {
    const { service } = build({ sessions: [] });
    const result = await service.end({ sessionFamilyId: 'fam_missing', actor: actorCtx() });
    expect(result).toEqual({ ok: false, failure: { kind: 'family_not_found' } });
  });

  it('refuses to revoke an ordinary (non-impersonation) session', async () => {
    const { service, sessions } = build({
      sessions: [
        { familyId: 'fam_normal', userId: TARGET, impersonatorUserId: null, revokedAt: null },
      ],
    });
    const result = await service.end({ sessionFamilyId: 'fam_normal', actor: actorCtx() });
    expect(result).toEqual({ ok: false, failure: { kind: 'not_impersonation' } });
    expect(sessions[0]?.revokedAt).toBeNull();
  });

  it('revokes the family and audits the end atomically', async () => {
    const { service, emit, sessions } = build({
      sessions: [
        { familyId: 'fam_imp_1', userId: TARGET, impersonatorUserId: OPERATOR, revokedAt: null },
        { familyId: 'fam_imp_1', userId: TARGET, impersonatorUserId: OPERATOR, revokedAt: null },
      ],
    });

    const result = await service.end({ sessionFamilyId: 'fam_imp_1', actor: actorCtx() });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.ended).toBe(true);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

    expect(emit).toHaveBeenCalledTimes(1);
    const [, , descriptor] = emit.mock.calls[0] as [
      unknown,
      unknown,
      { action: string; resourceId: string; after: Record<string, unknown> },
    ];
    expect(descriptor.action).toBe('user_impersonation:end');
    expect(descriptor.resourceId).toBe(TARGET);
    expect(descriptor.after['operatorUserId']).toBe(OPERATOR);
    expect(descriptor.after['active']).toBe(false);
  });

  it('is idempotent — an already-ended family reports ended: false and emits nothing', async () => {
    const { service, emit } = build({
      sessions: [
        {
          familyId: 'fam_imp_1',
          userId: TARGET,
          impersonatorUserId: OPERATOR,
          revokedAt: new Date('2026-07-02T11:00:00.000Z'),
        },
      ],
    });

    const result = await service.end({ sessionFamilyId: 'fam_imp_1', actor: actorCtx() });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.ended).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
