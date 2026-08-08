import { describe, expect, it } from 'vitest';

import { Prisma } from '../../../../prisma/generated';
import type { PrismaService } from '../../../prisma/prisma.service';

import { ActivityService, type ActivityEventKind, type RecordEventInput } from './activity.service';

/**
 * ActivityService unit tests. The service runs against a Prisma fake
 * (`FakePrisma`) that mimics the surface area the production code
 * uses: `activityEvent.findUnique` / `findMany` / `create`. Integration
 * tests against a real Postgres land with TS-009e (Testcontainers).
 */

interface PersistedRow {
  id: string;
  eventId: string;
  userId: string;
  kind: ActivityEventKind;
  occurredAt: Date;
  ip: string | null;
  userAgent: string | null;
  deviceFingerprint: string | null;
  requestId: string | null;
  traceId: string | null;
  metadata: unknown;
  createdAt: Date;
}

class FakePrisma {
  private rows: PersistedRow[] = [];
  private nextRowSeq = 0;
  /**
   * When set, the next `create` call throws a P2002 unique-constraint
   * error and then resets — exercises the race-recovery code path.
   */
  public simulateP2002Once = false;

  public readonly activityEvent = {
    findUnique: async ({ where }: { where: { eventId: string } }): Promise<PersistedRow | null> => {
      return this.rows.find((r) => r.eventId === where.eventId) ?? null;
    },
    findMany: async ({
      where,
      take,
    }: {
      where: Record<string, unknown>;
      take: number;
    }): Promise<PersistedRow[]> => {
      let matches = this.rows.slice();
      if (typeof where['userId'] === 'string') {
        matches = matches.filter((r) => r.userId === where['userId']);
      }
      if (typeof where['kind'] === 'string') {
        matches = matches.filter((r) => r.kind === where['kind']);
      }
      // Decode cursor for parity with the prod path.
      const or = where['OR'] as
        | ReadonlyArray<{
            occurredAt?: { lt?: Date; equals?: Date };
            id?: { lt?: string };
          }>
        | undefined;
      if (or !== undefined) {
        const lt = or[0]?.occurredAt?.lt;
        const eq = or[1]?.occurredAt?.equals;
        const idLt = or[1]?.id?.lt;
        if (lt !== undefined && eq !== undefined && idLt !== undefined) {
          matches = matches.filter(
            (r) =>
              r.occurredAt.getTime() < lt.getTime() ||
              (r.occurredAt.getTime() === eq.getTime() && r.id < idLt),
          );
        }
      }
      matches.sort((a, b) => {
        const dt = b.occurredAt.getTime() - a.occurredAt.getTime();
        if (dt !== 0) return dt;
        return b.id.localeCompare(a.id);
      });
      return matches.slice(0, take);
    },
    create: async ({
      data,
    }: {
      data: Omit<PersistedRow, 'id' | 'createdAt'>;
    }): Promise<PersistedRow> => {
      if (this.simulateP2002Once) {
        this.simulateP2002Once = false;
        // Mirror Prisma's P2002 unique-constraint error shape and
        // also persist the winner row to simulate the peer commit.
        this.persistInsert({ ...data, id: 'race_winner', eventId: data.eventId });
        const err = new Error('Unique constraint failed') as Error & { code: string };
        err.code = 'P2002';
        throw err;
      }
      if (this.rows.some((r) => r.eventId === data.eventId)) {
        const err = new Error('Unique constraint failed') as Error & { code: string };
        err.code = 'P2002';
        throw err;
      }
      this.nextRowSeq += 1;
      const id = `row_${String(this.nextRowSeq).padStart(6, '0')}`;
      return this.persistInsert({ ...data, id });
    },
  };

  /** Manual seed for tests that pre-load rows without going through create(). */
  public seed(row: PersistedRow): void {
    this.rows.push(row);
  }

  private persistInsert(row: Omit<PersistedRow, 'createdAt'> & { id: string }): PersistedRow {
    const persisted: PersistedRow = {
      ...row,
      // Mirror the driver: on a nullable Json column `Prisma.DbNull` is the
      // sentinel meaning "write SQL NULL", and the column reads back as a
      // plain `null`. Without this the fake would echo the sentinel object
      // straight back and diverge from real Postgres (TS-501).
      metadata: row.metadata === Prisma.DbNull ? null : (row.metadata ?? null),
      createdAt: new Date(),
    };
    this.rows.push(persisted);
    return persisted;
  }
}

function buildService(): { svc: ActivityService; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  const svc = new ActivityService(prisma as unknown as PrismaService);
  return { svc, prisma };
}

function baseInput(overrides: Partial<RecordEventInput> = {}): RecordEventInput {
  return {
    eventId: 'evt_001',
    userId: 'user_001',
    kind: 'login_success',
    occurredAt: new Date('2026-05-14T12:00:00.000Z'),
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    deviceFingerprint: 'fpr_abc',
    requestId: 'req_001',
    traceId: 'trace_001',
    metadata: { app: 'web' },
    ...overrides,
  };
}

describe('ActivityService.recordEvent', () => {
  it('records a fresh event and returns the recorded outcome', async () => {
    const { svc } = buildService();
    const result = await svc.recordEvent(baseInput());
    expect(result.outcome).toBe('recorded');
    expect(result.event.eventId).toBe('evt_001');
    expect(result.event.userId).toBe('user_001');
    expect(result.event.kind).toBe('login_success');
    expect(result.event.id).toBe('row_000001');
  });

  it('replays an existing event idempotently on eventId', async () => {
    const { svc } = buildService();
    const first = await svc.recordEvent(baseInput());
    const second = await svc.recordEvent(baseInput({ userAgent: 'different-but-ignored' }));
    expect(second.outcome).toBe('replayed');
    expect(second.event.id).toBe(first.event.id);
    // The replay preserves the FIRST insert's metadata — the second
    // call's modified userAgent is ignored.
    expect(second.event.userAgent).toBe('Mozilla/5.0');
  });

  it('round-trips null adjunct fields', async () => {
    const { svc } = buildService();
    const result = await svc.recordEvent(
      baseInput({
        ip: null,
        userAgent: null,
        deviceFingerprint: null,
        requestId: null,
        traceId: null,
        metadata: null,
      }),
    );
    expect(result.outcome).toBe('recorded');
    expect(result.event.ip).toBeNull();
    expect(result.event.metadata).toBeNull();
  });

  it('round-trips a structured metadata payload', async () => {
    const { svc } = buildService();
    const metadata = { from: 'tier_1', to: 'tier_2', reason: 'upgrade' };
    const result = await svc.recordEvent(baseInput({ metadata }));
    expect(result.event.metadata).toEqual(metadata);
  });

  it('recovers from a P2002 race by reading the winner', async () => {
    const { svc, prisma } = buildService();
    prisma.simulateP2002Once = true;
    const result = await svc.recordEvent(baseInput());
    expect(result.outcome).toBe('replayed');
    expect(result.event.id).toBe('race_winner');
  });

  it('records two distinct events for the same user', async () => {
    const { svc } = buildService();
    await svc.recordEvent(baseInput({ eventId: 'evt_001', kind: 'login_success' }));
    await svc.recordEvent(
      baseInput({
        eventId: 'evt_002',
        kind: 'profile_changed',
        occurredAt: new Date('2026-05-14T12:30:00.000Z'),
      }),
    );
    const result = await svc.listByUser({ userId: 'user_001', limit: 10 });
    expect(result.events).toHaveLength(2);
    // Newest first
    expect(result.events[0]?.eventId).toBe('evt_002');
    expect(result.events[1]?.eventId).toBe('evt_001');
  });

  it('rethrows non-P2002 errors unchanged', async () => {
    const { svc, prisma } = buildService();
    prisma.activityEvent.create = async (): Promise<PersistedRow> => {
      throw new Error('connection lost');
    };
    await expect(svc.recordEvent(baseInput())).rejects.toThrow('connection lost');
  });
});

describe('ActivityService.listByUser', () => {
  it('returns empty when the user has no events', async () => {
    const { svc } = buildService();
    const result = await svc.listByUser({ userId: 'user_000', limit: 10 });
    expect(result.events).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it('returns events newest-first', async () => {
    const { svc } = buildService();
    await svc.recordEvent(
      baseInput({
        eventId: 'evt_a',
        occurredAt: new Date('2026-05-14T10:00:00.000Z'),
      }),
    );
    await svc.recordEvent(
      baseInput({
        eventId: 'evt_b',
        occurredAt: new Date('2026-05-14T12:00:00.000Z'),
      }),
    );
    await svc.recordEvent(
      baseInput({
        eventId: 'evt_c',
        occurredAt: new Date('2026-05-14T11:00:00.000Z'),
      }),
    );
    const result = await svc.listByUser({ userId: 'user_001', limit: 10 });
    expect(result.events.map((e) => e.eventId)).toEqual(['evt_b', 'evt_c', 'evt_a']);
  });

  it('filters by kind when kindFilter is supplied', async () => {
    const { svc } = buildService();
    await svc.recordEvent(baseInput({ eventId: 'evt_login_1', kind: 'login_success' }));
    await svc.recordEvent(baseInput({ eventId: 'evt_logout', kind: 'logout' }));
    await svc.recordEvent(baseInput({ eventId: 'evt_login_2', kind: 'login_success' }));
    const result = await svc.listByUser({
      userId: 'user_001',
      kindFilter: 'login_success',
      limit: 10,
    });
    expect(result.events.map((e) => e.eventId).sort()).toEqual(['evt_login_1', 'evt_login_2']);
  });

  it('emits a nextCursor when the page is full', async () => {
    const { svc } = buildService();
    for (let i = 0; i < 5; i += 1) {
      await svc.recordEvent(
        baseInput({
          eventId: `evt_${i}`,
          occurredAt: new Date(`2026-05-14T${String(10 + i).padStart(2, '0')}:00:00.000Z`),
        }),
      );
    }
    const result = await svc.listByUser({ userId: 'user_001', limit: 3 });
    expect(result.events).toHaveLength(3);
    expect(result.nextCursor).not.toBeNull();
  });

  it('paginates without overlap across cursor boundaries', async () => {
    const { svc } = buildService();
    for (let i = 0; i < 5; i += 1) {
      await svc.recordEvent(
        baseInput({
          eventId: `evt_${i}`,
          occurredAt: new Date(`2026-05-14T${String(10 + i).padStart(2, '0')}:00:00.000Z`),
        }),
      );
    }
    const page1 = await svc.listByUser({ userId: 'user_001', limit: 2 });
    expect(page1.events).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await svc.listByUser({
      userId: 'user_001',
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.events).toHaveLength(2);

    const page3 = await svc.listByUser({
      userId: 'user_001',
      limit: 2,
      cursor: page2.nextCursor ?? undefined,
    });
    expect(page3.events).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const ids = new Set([
      ...page1.events.map((e) => e.eventId),
      ...page2.events.map((e) => e.eventId),
      ...page3.events.map((e) => e.eventId),
    ]);
    expect(ids.size).toBe(5);
  });

  it("isolates results across users (a user cannot see another user's events)", async () => {
    const { svc } = buildService();
    await svc.recordEvent(baseInput({ eventId: 'evt_a', userId: 'user_001' }));
    await svc.recordEvent(baseInput({ eventId: 'evt_b', userId: 'user_002' }));
    const r1 = await svc.listByUser({ userId: 'user_001', limit: 10 });
    const r2 = await svc.listByUser({ userId: 'user_002', limit: 10 });
    expect(r1.events.map((e) => e.eventId)).toEqual(['evt_a']);
    expect(r2.events.map((e) => e.eventId)).toEqual(['evt_b']);
  });

  it('returns no nextCursor when the page is exactly full but no more rows exist', async () => {
    const { svc } = buildService();
    await svc.recordEvent(baseInput({ eventId: 'evt_a' }));
    await svc.recordEvent(
      baseInput({
        eventId: 'evt_b',
        occurredAt: new Date('2026-05-14T13:00:00.000Z'),
      }),
    );
    const result = await svc.listByUser({ userId: 'user_001', limit: 2 });
    expect(result.events).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it('treats a malformed cursor as no cursor', async () => {
    const { svc } = buildService();
    await svc.recordEvent(baseInput({ eventId: 'evt_a' }));
    const result = await svc.listByUser({
      userId: 'user_001',
      cursor: 'not-a-real-cursor!!!!!',
      limit: 10,
    });
    // Falls back to "no cursor" — returns the full result set rather
    // than erroring out (defensive, matches the audit-svc behavior).
    expect(result.events).toHaveLength(1);
  });
});
