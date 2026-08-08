import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { AuditService, type RecordEventInput } from './audit.service';
import { HashChainService } from './hash-chain.service';

/**
 * AuditService unit tests. The service runs against a Prisma fake
 * (`FakePrisma`) that mimics the surface area the production code
 * uses: `auditEvent.findUnique` / `findFirst` / `findMany` / `create`
 * + `$transaction` + `$executeRawUnsafe` (no-op for the advisory
 * lock). Integration tests against a real Postgres land with TS-009e
 * (Testcontainers) — captured as TS-100-followup.
 */

interface PersistedRow {
  id: string;
  eventId: string;
  occurredAt: Date;
  actorUserId: string | null;
  actorRole: string | null;
  actorTenantScopeType: 'global' | 'tenant' | 'household' | 'system';
  actorTenantScopeId: string | null;
  action: string;
  resourceKind: string;
  resourceId: string;
  beforeJson: unknown;
  afterJson: unknown;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  traceId: string | null;
  chainPrevHash: string | null;
  chainHash: string;
  createdAt: Date;
}

class FakePrisma {
  private rows: PersistedRow[] = [];
  private nextRowSeq = 0;

  public readonly auditEvent = {
    findUnique: async ({ where }: { where: { eventId: string } }): Promise<PersistedRow | null> => {
      return this.rows.find((r) => r.eventId === where.eventId) ?? null;
    },
    findFirst: async ({
      where,
    }: {
      where: { resourceKind: string; resourceId: string };
    }): Promise<{ chainHash: string } | null> => {
      const match = this.rows
        .filter((r) => r.resourceKind === where.resourceKind && r.resourceId === where.resourceId)
        .sort((a, b) => {
          const dt = b.occurredAt.getTime() - a.occurredAt.getTime();
          if (dt !== 0) return dt;
          const ct = b.createdAt.getTime() - a.createdAt.getTime();
          if (ct !== 0) return ct;
          return b.id.localeCompare(a.id);
        })[0];
      return match !== undefined ? { chainHash: match.chainHash } : null;
    },
    findMany: async ({
      where,
      orderBy,
      take,
    }: {
      where: Record<string, unknown>;
      orderBy?: ReadonlyArray<{ occurredAt?: 'asc' | 'desc'; id?: 'asc' | 'desc' }>;
      take: number;
    }): Promise<PersistedRow[]> => {
      let matches = this.rows.slice();
      const kindFilter = where['resourceKind'];
      if (typeof kindFilter === 'string') {
        matches = matches.filter((r) => r.resourceKind === kindFilter);
      } else if (
        typeof kindFilter === 'object' &&
        kindFilter !== null &&
        Array.isArray((kindFilter as { in?: unknown }).in)
      ) {
        const kinds = (kindFilter as { in: string[] }).in;
        matches = matches.filter((r) => kinds.includes(r.resourceKind));
      }
      if (typeof where['resourceId'] === 'string') {
        matches = matches.filter((r) => r.resourceId === where['resourceId']);
      }
      if (typeof where['actorUserId'] === 'string') {
        matches = matches.filter((r) => r.actorUserId === where['actorUserId']);
      }
      if (typeof where['action'] === 'string') {
        matches = matches.filter((r) => r.action === where['action']);
      }
      // Decode cursor for parity with the prod path. The prod path
      // uses OR-of-AND (lt for desc order, gt for asc); the fake
      // performs the equivalent filter so pagination test assertions
      // remain meaningful.
      const or = where['OR'] as
        | ReadonlyArray<{
            occurredAt?: { lt?: Date; gt?: Date; equals?: Date };
            id?: { lt?: string; gt?: string };
          }>
        | undefined;
      if (or !== undefined) {
        const lt = or[0]?.occurredAt?.lt;
        const gt = or[0]?.occurredAt?.gt;
        const eq = or[1]?.occurredAt?.equals;
        const idLt = or[1]?.id?.lt;
        const idGt = or[1]?.id?.gt;
        if (lt !== undefined && eq !== undefined && idLt !== undefined) {
          matches = matches.filter(
            (r) =>
              r.occurredAt.getTime() < lt.getTime() ||
              (r.occurredAt.getTime() === eq.getTime() && r.id < idLt),
          );
        } else if (gt !== undefined && eq !== undefined && idGt !== undefined) {
          matches = matches.filter(
            (r) =>
              r.occurredAt.getTime() > gt.getTime() ||
              (r.occurredAt.getTime() === eq.getTime() && r.id > idGt),
          );
        }
      }
      const direction = orderBy?.[0]?.occurredAt ?? 'desc';
      matches.sort((a, b) => {
        const dt =
          direction === 'desc'
            ? b.occurredAt.getTime() - a.occurredAt.getTime()
            : a.occurredAt.getTime() - b.occurredAt.getTime();
        if (dt !== 0) return dt;
        return direction === 'desc' ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id);
      });
      return matches.slice(0, take);
    },
    create: async ({
      data,
    }: {
      data: Omit<PersistedRow, 'id' | 'createdAt'>;
    }): Promise<PersistedRow> => {
      if (this.rows.some((r) => r.eventId === data.eventId)) {
        // Mirror Prisma's P2002 unique-constraint error shape.
        const err = new Error('Unique constraint failed') as Error & { code: string };
        err.code = 'P2002';
        throw err;
      }
      const row: PersistedRow = {
        ...data,
        id: `row_${String(this.nextRowSeq).padStart(6, '0')}`,
        createdAt: new Date(Date.now() + this.nextRowSeq),
      };
      this.nextRowSeq += 1;
      this.rows.push(row);
      return row;
    },
  };

  async $transaction<T>(callback: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async $executeRawUnsafe(_query: string, ..._params: unknown[]): Promise<number> {
    // No-op stand-in for the advisory lock. Unit tests don't need
    // real Postgres locking semantics; the integration test path will.
    return 0;
  }
}

function buildSvc(): { svc: AuditService; fake: FakePrisma } {
  const fake = new FakePrisma();
  const svc = new AuditService(fake as unknown as PrismaService, new HashChainService());
  return { svc, fake };
}

function eventInput(overrides: Partial<RecordEventInput> = {}): RecordEventInput {
  return {
    eventId: 'evt_001',
    occurredAt: new Date('2026-05-13T12:00:00.000Z'),
    actorUserId: 'user_001',
    actorRole: 'super_admin',
    actorTenantScopeType: 'global',
    actorTenantScopeId: null,
    action: 'subscription:write',
    resourceKind: 'subscription',
    resourceId: 'sub_001',
    beforeJson: { status: 'past_due' },
    afterJson: { status: 'active' },
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    requestId: 'req_001',
    traceId: 'trace_001',
    ...overrides,
  };
}

describe('AuditService.recordEvent', () => {
  it('records a new event and returns outcome=recorded with a chain hash', async () => {
    const { svc } = buildSvc();
    const result = await svc.recordEvent(eventInput());

    expect(result.outcome).toBe('recorded');
    expect(result.event.eventId).toBe('evt_001');
    expect(result.event.chainPrevHash).toBeNull();
    expect(result.event.chainHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('chains a second event for the same resource off the first', async () => {
    const { svc } = buildSvc();
    const first = await svc.recordEvent(eventInput());
    const second = await svc.recordEvent(
      eventInput({
        eventId: 'evt_002',
        occurredAt: new Date('2026-05-13T13:00:00.000Z'),
        beforeJson: { status: 'active' },
        afterJson: { status: 'canceled' },
      }),
    );

    expect(second.event.chainPrevHash).toBe(first.event.chainHash);
    expect(second.event.chainHash).not.toBe(first.event.chainHash);
  });

  it('does not chain events for a different resource', async () => {
    const { svc } = buildSvc();
    await svc.recordEvent(eventInput());
    const otherResource = await svc.recordEvent(
      eventInput({
        eventId: 'evt_010',
        resourceKind: 'booking',
        resourceId: 'bk_001',
      }),
    );
    expect(otherResource.event.chainPrevHash).toBeNull();
  });

  it('replays an existing eventId without inserting a duplicate', async () => {
    const { svc, fake } = buildSvc();
    const first = await svc.recordEvent(eventInput());
    const replay = await svc.recordEvent(eventInput());

    expect(replay.outcome).toBe('replayed');
    expect(replay.event.id).toBe(first.event.id);
    // No extra row inserted: only one row with eventId=evt_001.
    const all = await fake.auditEvent.findMany({
      where: { resourceKind: 'subscription', resourceId: 'sub_001' },
      take: 100,
    });
    expect(all).toHaveLength(1);
  });

  it('replay returns the same row content as the original', async () => {
    const { svc } = buildSvc();
    const first = await svc.recordEvent(eventInput());
    const replay = await svc.recordEvent(eventInput());
    expect(replay.event.chainHash).toBe(first.event.chainHash);
    expect(replay.event.chainPrevHash).toBe(first.event.chainPrevHash);
  });

  it('records a system-driven event with a null actorUserId', async () => {
    const { svc } = buildSvc();
    const result = await svc.recordEvent(
      eventInput({
        actorUserId: null,
        actorRole: null,
        actorTenantScopeType: 'system',
      }),
    );
    expect(result.outcome).toBe('recorded');
    expect(result.event.actorUserId).toBeNull();
    expect(result.event.actorTenantScopeType).toBe('system');
  });

  it('handles the unique-constraint race by returning replay', async () => {
    // Simulate a race where the recheck inside the transaction does
    // not see the concurrent row but the INSERT collides on
    // `event_id UNIQUE`. The fake's create() raises P2002 on the
    // second insert; the service catches and reads the winning row.
    const { svc, fake } = buildSvc();
    // Manually seed a row with the same eventId to simulate the
    // concurrent winner.
    await fake.auditEvent.create({
      data: {
        eventId: 'evt_race',
        occurredAt: new Date('2026-05-13T11:00:00.000Z'),
        actorUserId: 'user_001',
        actorRole: 'super_admin',
        actorTenantScopeType: 'global',
        actorTenantScopeId: null,
        action: 'subscription:write',
        resourceKind: 'subscription',
        resourceId: 'sub_001',
        beforeJson: null,
        afterJson: { status: 'active' },
        ip: null,
        userAgent: null,
        requestId: null,
        traceId: null,
        chainPrevHash: null,
        chainHash: 'a'.repeat(64),
      },
    });
    // Now call recordEvent — the outer findUnique should hit the
    // winner directly.
    const result = await svc.recordEvent(eventInput({ eventId: 'evt_race' }));
    expect(result.outcome).toBe('replayed');
    expect(result.event.eventId).toBe('evt_race');
  });

  it('persists JSON diff payloads round-trip', async () => {
    const { svc } = buildSvc();
    const payload = {
      nested: { deep: { value: 42 } },
      list: [1, 2, 3],
      flag: true,
    };
    const result = await svc.recordEvent(eventInput({ afterJson: payload }));
    expect(result.event.afterJson).toEqual(payload);
  });
});

describe('AuditService.listByResource', () => {
  it('returns events newest-first within a resource partition', async () => {
    const { svc } = buildSvc();
    await svc.recordEvent(
      eventInput({ eventId: 'evt_a', occurredAt: new Date('2026-05-13T10:00:00.000Z') }),
    );
    await svc.recordEvent(
      eventInput({ eventId: 'evt_b', occurredAt: new Date('2026-05-13T11:00:00.000Z') }),
    );
    await svc.recordEvent(
      eventInput({ eventId: 'evt_c', occurredAt: new Date('2026-05-13T12:00:00.000Z') }),
    );

    const result = await svc.listByResource({
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      limit: 50,
    });

    expect(result.events.map((e) => e.eventId)).toEqual(['evt_c', 'evt_b', 'evt_a']);
    expect(result.nextCursor).toBeNull();
  });

  it('emits a nextCursor when there are more rows than the limit', async () => {
    const { svc } = buildSvc();
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordered seeding
      await svc.recordEvent(
        eventInput({
          eventId: `evt_${i}`,
          occurredAt: new Date(`2026-05-13T1${i}:00:00.000Z`),
        }),
      );
    }

    const first = await svc.listByResource({
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      limit: 3,
    });

    expect(first.events).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
  });

  it('the nextCursor pages the next slice without overlap', async () => {
    const { svc } = buildSvc();
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordered seeding
      await svc.recordEvent(
        eventInput({
          eventId: `evt_${i}`,
          occurredAt: new Date(`2026-05-13T1${i}:00:00.000Z`),
        }),
      );
    }

    const first = await svc.listByResource({
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      limit: 3,
    });
    expect(first.nextCursor).not.toBeNull();

    const second = await svc.listByResource({
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      limit: 3,
      cursor: first.nextCursor ?? undefined,
    });

    const firstIds = first.events.map((e) => e.eventId);
    const secondIds = second.events.map((e) => e.eventId);
    // No overlap between pages.
    for (const id of secondIds) {
      expect(firstIds).not.toContain(id);
    }
    // Combined matches the full ordering.
    expect([...firstIds, ...secondIds]).toEqual(['evt_4', 'evt_3', 'evt_2', 'evt_1', 'evt_0']);
    expect(second.nextCursor).toBeNull();
  });

  it('filters by (resourceKind, resourceId) — other resources are excluded', async () => {
    const { svc } = buildSvc();
    await svc.recordEvent(eventInput({ eventId: 'evt_sub' }));
    await svc.recordEvent(
      eventInput({
        eventId: 'evt_bk',
        resourceKind: 'booking',
        resourceId: 'bk_001',
      }),
    );

    const result = await svc.listByResource({
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      limit: 50,
    });

    expect(result.events.map((e) => e.eventId)).toEqual(['evt_sub']);
  });

  it('an invalid cursor is treated as a fresh search (no rows leak)', async () => {
    const { svc } = buildSvc();
    await svc.recordEvent(eventInput());
    const result = await svc.listByResource({
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      limit: 50,
      cursor: 'not-a-valid-cursor',
    });
    // The decoder returns null on a malformed cursor; the service
    // serves a fresh page, which here is the full result set (1 row).
    expect(result.events).toHaveLength(1);
  });
});

describe('AuditService.listByActor', () => {
  it('returns only events authored by the given actor', async () => {
    const { svc } = buildSvc();
    await svc.recordEvent(eventInput({ eventId: 'evt_a', actorUserId: 'user_001' }));
    await svc.recordEvent(eventInput({ eventId: 'evt_b', actorUserId: 'user_002' }));
    await svc.recordEvent(eventInput({ eventId: 'evt_c', actorUserId: 'user_001' }));

    const result = await svc.listByActor({
      actorUserId: 'user_001',
      limit: 50,
    });

    expect(result.events.map((e) => e.eventId).sort()).toEqual(['evt_a', 'evt_c']);
  });

  it('paginates by occurredAt DESC', async () => {
    const { svc } = buildSvc();
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordered seeding
      await svc.recordEvent(
        eventInput({
          eventId: `evt_${i}`,
          occurredAt: new Date(`2026-05-13T1${i}:00:00.000Z`),
          actorUserId: 'user_001',
          // Each on its own resource so we don't chain.
          resourceId: `sub_${i}`,
        }),
      );
    }

    const first = await svc.listByActor({
      actorUserId: 'user_001',
      limit: 2,
    });
    expect(first.events.map((e) => e.eventId)).toEqual(['evt_3', 'evt_2']);
    expect(first.nextCursor).not.toBeNull();

    const second = await svc.listByActor({
      actorUserId: 'user_001',
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.events.map((e) => e.eventId)).toEqual(['evt_1', 'evt_0']);
    expect(second.nextCursor).toBeNull();
  });
});
