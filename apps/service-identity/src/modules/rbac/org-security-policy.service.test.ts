import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { OrgSecurityPolicyService } from './org-security-policy.service';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { AuditEmitter } from '@taste-and-see/nest-audit';

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

interface FakePolicyRow {
  id: string;
  scopeId: string;
  ssoRequired: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory fake of the slice of Prisma the service touches:
 * `org_security_policies` plus the `$transaction(callback)`
 * interactive-transaction surface (the fake runs the callback against
 * itself — atomicity is the DB's job; these tests assert the
 * service's orchestration, no-op short-circuit, and audit wiring).
 */
function buildFakePrisma(seed: FakePolicyRow[] = []): {
  prisma: PrismaService;
  rows: Map<string, FakePolicyRow>;
} {
  const rows = new Map<string, FakePolicyRow>();
  for (const r of seed) rows.set(r.scopeId, r);
  let counter = 0;

  const surface = {
    findMany: vi.fn(async () =>
      [...rows.values()].sort((a, b) => a.scopeId.localeCompare(b.scopeId)),
    ),
    findUnique: vi.fn(async (req: { where: { scopeId: string } }) => {
      return rows.get(req.where.scopeId) ?? null;
    }),
    count: vi.fn(async (req: { where: { scopeId: { in: string[] }; ssoRequired: boolean } }) => {
      return [...rows.values()].filter(
        (r) => req.where.scopeId.in.includes(r.scopeId) && r.ssoRequired === req.where.ssoRequired,
      ).length;
    }),
    create: vi.fn(async (req: { data: { scopeId: string; ssoRequired: boolean } }) => {
      counter += 1;
      const row: FakePolicyRow = {
        id: `pol_${counter}`,
        scopeId: req.data.scopeId,
        ssoRequired: req.data.ssoRequired,
        createdAt: new Date('2026-07-02T12:00:00.000Z'),
        updatedAt: new Date('2026-07-02T12:00:00.000Z'),
      };
      rows.set(row.scopeId, row);
      return row;
    }),
    update: vi.fn(async (req: { where: { scopeId: string }; data: { ssoRequired: boolean } }) => {
      const existing = rows.get(req.where.scopeId);
      if (existing === undefined) throw new Error('P2025: record not found');
      const next: FakePolicyRow = {
        ...existing,
        ssoRequired: req.data.ssoRequired,
        updatedAt: new Date('2026-07-02T13:00:00.000Z'),
      };
      rows.set(next.scopeId, next);
      return next;
    }),
  };

  const prisma = {
    orgSecurityPolicy: surface,
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ orgSecurityPolicy: surface }),
    ),
  } as unknown as PrismaService;

  return { prisma, rows };
}

function fakeAudit(): { emitter: AuditEmitter; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn(async () => undefined);
  return { emitter: { emit } as unknown as AuditEmitter, emit };
}

describe('OrgSecurityPolicyService.upsertPolicy', () => {
  it('creates a missing row and emits org_security_policy:create with null before', async () => {
    const { prisma } = buildFakePrisma();
    const { emitter, emit } = fakeAudit();
    const svc = new OrgSecurityPolicyService(prisma, emitter);

    const row = await svc.upsertPolicy({
      scopeId: 'tenant_abc',
      ssoRequired: true,
      actor: actorCtx('usr_admin'),
    });

    expect(row.scopeId).toBe('tenant_abc');
    expect(row.ssoRequired).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    const [, actor, descriptor] = emit.mock.calls[0] as [
      unknown,
      AuditActorContext,
      { action: string; resourceKind: string; before: unknown; after: unknown },
    ];
    expect(actor.actorUserId).toBe('usr_admin');
    expect(descriptor.action).toBe('org_security_policy:create');
    expect(descriptor.resourceKind).toBe('org_security_policy');
    expect(descriptor.before).toBeNull();
    expect(descriptor.after).toEqual({ scopeId: 'tenant_abc', ssoRequired: true });
  });

  it('updates an existing row and emits org_security_policy:update with before/after', async () => {
    const { prisma } = buildFakePrisma([
      {
        id: 'pol_1',
        scopeId: 'global',
        ssoRequired: false,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ]);
    const { emitter, emit } = fakeAudit();
    const svc = new OrgSecurityPolicyService(prisma, emitter);

    const row = await svc.upsertPolicy({
      scopeId: 'global',
      ssoRequired: true,
      actor: actorCtx('usr_admin'),
    });

    expect(row.ssoRequired).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    const [, , descriptor] = emit.mock.calls[0] as [
      unknown,
      unknown,
      { action: string; before: unknown; after: unknown },
    ];
    expect(descriptor.action).toBe('org_security_policy:update');
    expect(descriptor.before).toEqual({ scopeId: 'global', ssoRequired: false });
    expect(descriptor.after).toEqual({ scopeId: 'global', ssoRequired: true });
  });

  it('short-circuits a no-op upsert without a transaction or audit event', async () => {
    const { prisma } = buildFakePrisma([
      {
        id: 'pol_1',
        scopeId: 'tenant_abc',
        ssoRequired: true,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ]);
    const { emitter, emit } = fakeAudit();
    const svc = new OrgSecurityPolicyService(prisma, emitter);

    const row = await svc.upsertPolicy({
      scopeId: 'tenant_abc',
      ssoRequired: true,
      actor: actorCtx('usr_admin'),
    });

    expect(row.id).toBe('pol_1');
    expect(emit).not.toHaveBeenCalled();
    expect(
      (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction,
    ).not.toHaveBeenCalled();
  });

  it('propagates an audit-emit failure so the mutation transaction aborts', async () => {
    const { prisma, rows } = buildFakePrisma();
    const emit = vi.fn(async () => {
      throw new Error('audit payload rejected');
    });
    const svc = new OrgSecurityPolicyService(prisma, {
      emit,
    } as unknown as AuditEmitter);

    await expect(
      svc.upsertPolicy({ scopeId: 'tenant_abc', ssoRequired: true, actor: actorCtx('usr_a') }),
    ).rejects.toThrow('audit payload rejected');
    // The fake has no real rollback — the assertion that matters is
    // that the error escapes $transaction (real Postgres rolls back).
    expect(rows.has('tenant_abc')).toBe(true);
  });
});

describe('OrgSecurityPolicyService.ssoRequiredForScopes', () => {
  const seeded: FakePolicyRow[] = [
    {
      id: 'pol_1',
      scopeId: 'tenant_sso',
      ssoRequired: true,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    },
    {
      id: 'pol_2',
      scopeId: 'tenant_relaxed',
      ssoRequired: false,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    },
  ];

  it('is true when any scope id has ssoRequired: true', async () => {
    const { prisma } = buildFakePrisma(seeded);
    const svc = new OrgSecurityPolicyService(prisma, fakeAudit().emitter);
    await expect(svc.ssoRequiredForScopes(['tenant_relaxed', 'tenant_sso'])).resolves.toBe(true);
  });

  it('is false when matching rows exist but none require SSO', async () => {
    const { prisma } = buildFakePrisma(seeded);
    const svc = new OrgSecurityPolicyService(prisma, fakeAudit().emitter);
    await expect(svc.ssoRequiredForScopes(['tenant_relaxed'])).resolves.toBe(false);
  });

  it('is false for scopes with no policy row at all (default-off)', async () => {
    const { prisma } = buildFakePrisma(seeded);
    const svc = new OrgSecurityPolicyService(prisma, fakeAudit().emitter);
    await expect(svc.ssoRequiredForScopes(['tenant_unknown'])).resolves.toBe(false);
  });

  it('short-circuits empty input to false without querying', async () => {
    const { prisma } = buildFakePrisma(seeded);
    const svc = new OrgSecurityPolicyService(prisma, fakeAudit().emitter);
    await expect(svc.ssoRequiredForScopes([])).resolves.toBe(false);
    expect(
      (prisma as unknown as { orgSecurityPolicy: { count: ReturnType<typeof vi.fn> } })
        .orgSecurityPolicy.count,
    ).not.toHaveBeenCalled();
  });
});

describe('OrgSecurityPolicyService.listPolicies', () => {
  it('returns every row ordered by scopeId', async () => {
    const { prisma } = buildFakePrisma([
      {
        id: 'pol_2',
        scopeId: 'tenant_b',
        ssoRequired: false,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
      {
        id: 'pol_1',
        scopeId: 'global',
        ssoRequired: true,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ]);
    const svc = new OrgSecurityPolicyService(prisma, fakeAudit().emitter);
    const rows = await svc.listPolicies();
    expect(rows.map((r) => r.scopeId)).toEqual(['global', 'tenant_b']);
  });
});
