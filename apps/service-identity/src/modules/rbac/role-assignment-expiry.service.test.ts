import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import type { RbacExpiryEmitter, RoleAssignmentExpiredDescriptor } from './rbac-expiry-emitter';
import { RoleAssignmentExpiryService } from './role-assignment-expiry.service';
import { AuditEmitter } from '@taste-and-see/nest-audit';

/** Loose audit-emitter stub — TS-295 emission is asserted in its own suite. */
function fakeAudit(): AuditEmitter {
  return { emit: vi.fn(async () => undefined) } as unknown as AuditEmitter;
}

/**
 * Unit tests for the TS-293 expiry sweep. Deterministic clock via the
 * injectable `now` (CLAUDE.md §9.3 — no sleeps); the Prisma slice is an
 * in-memory fake of `user_roles` honoring the sweep's exact predicates.
 */

type DbScopeType = 'global' | 'tenant' | 'household';

interface FakeRow {
  id: string;
  userId: string;
  roleName: string;
  scopeType: DbScopeType;
  scopeId: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

function buildFakePrisma(rows: FakeRow[]): {
  prisma: PrismaService;
  rows: Map<string, FakeRow>;
  txCount: () => number;
} {
  const table = new Map<string, FakeRow>(rows.map((r) => [r.id, r]));
  let transactions = 0;

  const txSurface = {
    userRole: {
      findMany: vi.fn(
        async (req: { where: { revokedAt: null; expiresAt: { lt: Date } }; take: number }) => {
          const matches = [...table.values()]
            .filter(
              (r) =>
                r.revokedAt === null &&
                r.expiresAt !== null &&
                r.expiresAt.getTime() < req.where.expiresAt.lt.getTime(),
            )
            .sort((a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0))
            .slice(0, req.take);
          return matches.map((r) => ({
            id: r.id,
            userId: r.userId,
            scopeType: r.scopeType,
            scopeId: r.scopeId,
            expiresAt: r.expiresAt,
            role: { name: r.roleName },
          }));
        },
      ),
      updateMany: vi.fn(
        async (req: {
          where: { id: { in: string[] }; revokedAt: null };
          data: { revokedAt: Date };
        }) => {
          let count = 0;
          for (const id of req.where.id.in) {
            const row = table.get(id);
            if (row === undefined || row.revokedAt !== null) continue;
            row.revokedAt = req.data.revokedAt;
            count += 1;
          }
          return { count };
        },
      ),
    },
  };

  const prisma = {
    $transaction: vi.fn(async <T>(fn: (tx: typeof txSurface) => Promise<T>): Promise<T> => {
      transactions += 1;
      return fn(txSurface);
    }),
  } as unknown as PrismaService;

  return { prisma, rows: table, txCount: () => transactions };
}

function buildFakeEmitter(opts: { failOn?: string } = {}): {
  emitter: RbacExpiryEmitter;
  emitted: RoleAssignmentExpiredDescriptor[];
} {
  const emitted: RoleAssignmentExpiredDescriptor[] = [];
  const emitter = {
    emitExpired: vi.fn(async (_tx: unknown, descriptor: RoleAssignmentExpiredDescriptor) => {
      if (opts.failOn !== undefined && descriptor.assignmentId === opts.failOn) {
        throw new Error(`emit failed for ${descriptor.assignmentId}`);
      }
      emitted.push(descriptor);
    }),
  } as unknown as RbacExpiryEmitter;
  return { emitter, emitted };
}

const NOW = new Date('2026-07-01T12:00:00.000Z');
const PAST = new Date('2026-06-30T00:00:00.000Z');
const EARLIER_PAST = new Date('2026-06-29T00:00:00.000Z');
const FUTURE = new Date('2026-07-02T00:00:00.000Z');

function row(id: string, overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id,
    userId: `user_${id}`,
    roleName: 'operations_manager',
    scopeType: 'global',
    scopeId: null,
    expiresAt: PAST,
    revokedAt: null,
    ...overrides,
  };
}

describe('RoleAssignmentExpiryService.expireSweep', () => {
  it('returns zero counts when nothing is expired', async () => {
    const { prisma } = buildFakePrisma([
      row('ur_live', { expiresAt: null }),
      row('ur_future', { expiresAt: FUTURE }),
    ]);
    const { emitter, emitted } = buildFakeEmitter();
    const svc = new RoleAssignmentExpiryService(prisma, emitter, fakeAudit());

    const result = await svc.expireSweep({ now: NOW });

    expect(result).toEqual({ revokedCount: 0, batchCount: 0 });
    expect(emitted).toHaveLength(0);
  });

  it('revokes expired rows, stamps the sweep time, and emits one event per row', async () => {
    const { prisma, rows } = buildFakePrisma([
      row('ur_1'),
      row('ur_2', { scopeType: 'tenant', scopeId: 'tenant_a', roleName: 'partner_admin' }),
      row('ur_untouched', { expiresAt: FUTURE }),
    ]);
    const { emitter, emitted } = buildFakeEmitter();
    const svc = new RoleAssignmentExpiryService(prisma, emitter, fakeAudit());

    const result = await svc.expireSweep({ now: NOW });

    expect(result).toEqual({ revokedCount: 2, batchCount: 1 });
    expect(rows.get('ur_1')?.revokedAt).toEqual(NOW);
    expect(rows.get('ur_2')?.revokedAt).toEqual(NOW);
    expect(rows.get('ur_untouched')?.revokedAt).toBeNull();

    expect(emitted).toHaveLength(2);
    const forUr2 = emitted.find((e) => e.assignmentId === 'ur_2');
    expect(forUr2).toMatchObject({
      userId: 'user_ur_2',
      roleName: 'partner_admin',
      scopeType: 'tenant',
      scopeId: 'tenant_a',
      expiresAt: PAST,
      revokedAt: NOW,
    });
  });

  it('drains in multiple bounded batches, oldest expiry first', async () => {
    const { prisma, txCount } = buildFakePrisma([
      row('ur_a', { expiresAt: EARLIER_PAST }),
      row('ur_b'),
      row('ur_c'),
    ]);
    const { emitter, emitted } = buildFakeEmitter();
    const svc = new RoleAssignmentExpiryService(prisma, emitter, fakeAudit());

    const result = await svc.expireSweep({ now: NOW, batchSize: 2 });

    expect(result).toEqual({ revokedCount: 3, batchCount: 2 });
    // 2 full batches + the short second batch ends the loop (1 + 2 rows).
    expect(txCount()).toBe(2);
    expect(emitted[0]?.assignmentId).toBe('ur_a');
  });

  it('runs one extra empty probe when the last batch is exactly full', async () => {
    const { prisma, txCount } = buildFakePrisma([row('ur_1'), row('ur_2')]);
    const { emitter } = buildFakeEmitter();
    const svc = new RoleAssignmentExpiryService(prisma, emitter, fakeAudit());

    const result = await svc.expireSweep({ now: NOW, batchSize: 2 });

    expect(result).toEqual({ revokedCount: 2, batchCount: 1 });
    expect(txCount()).toBe(2); // full batch, then the empty probe that ends the loop
  });

  it('is idempotent — a second sweep finds nothing', async () => {
    const { prisma } = buildFakePrisma([row('ur_1')]);
    const { emitter, emitted } = buildFakeEmitter();
    const svc = new RoleAssignmentExpiryService(prisma, emitter, fakeAudit());

    const first = await svc.expireSweep({ now: NOW });
    const second = await svc.expireSweep({ now: NOW });

    expect(first.revokedCount).toBe(1);
    expect(second).toEqual({ revokedCount: 0, batchCount: 0 });
    expect(emitted).toHaveLength(1);
  });

  it('never touches manually-revoked rows', async () => {
    const manualRevokeStamp = new Date('2026-06-30T06:00:00.000Z');
    const { prisma, rows } = buildFakePrisma([
      row('ur_manual', { revokedAt: manualRevokeStamp }),
      row('ur_expired'),
    ]);
    const { emitter, emitted } = buildFakeEmitter();
    const svc = new RoleAssignmentExpiryService(prisma, emitter, fakeAudit());

    await svc.expireSweep({ now: NOW });

    expect(rows.get('ur_manual')?.revokedAt).toEqual(manualRevokeStamp);
    expect(emitted.map((e) => e.assignmentId)).toEqual(['ur_expired']);
  });

  it('propagates an emitter failure so the transaction aborts (outbox invariant)', async () => {
    const { prisma } = buildFakePrisma([row('ur_1'), row('ur_2')]);
    const { emitter } = buildFakeEmitter({ failOn: 'ur_2' });
    const svc = new RoleAssignmentExpiryService(prisma, emitter, fakeAudit());

    await expect(svc.expireSweep({ now: NOW })).rejects.toThrow('emit failed for ur_2');
  });
});
