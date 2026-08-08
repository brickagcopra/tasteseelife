import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import {
  AdminPeriodEventsService,
  decodeCursor,
  encodeCursor,
} from './admin-period-events.service';

const NOW = new Date('2026-05-18T12:00:00.000Z');

interface PersistedEventRow {
  readonly id: string;
  readonly periodId: string;
  readonly kind: 'close' | 'reopen';
  readonly actorUserId: string;
  readonly sourceEventId: string;
  readonly reasonCode: string;
  readonly description: string | null;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

function buildEvent(overrides: Partial<PersistedEventRow> = {}): PersistedEventRow {
  return {
    id: overrides.id ?? 'ple_default',
    periodId: overrides.periodId ?? 'per_a',
    kind: overrides.kind ?? 'close',
    actorUserId: overrides.actorUserId ?? 'usr_admin',
    sourceEventId: overrides.sourceEventId ?? 'evt_default',
    reasonCode: overrides.reasonCode ?? 'monthly_close',
    description: overrides.description ?? null,
    occurredAt: overrides.occurredAt ?? NOW,
    createdAt: overrides.createdAt ?? NOW,
  };
}

function buildPrismaStub(opts: {
  periodFindUnique?: (args: unknown) => Promise<{ id: string; name: string } | null>;
  eventFindMany?: (args: unknown) => Promise<PersistedEventRow[]>;
}): PrismaService {
  return {
    accountingPeriod: {
      findUnique: vi.fn(opts.periodFindUnique ?? (async () => null)),
    },
    periodLifecycleEvent: {
      findMany: vi.fn(opts.eventFindMany ?? (async () => [])),
    },
  } as unknown as PrismaService;
}

describe('AdminPeriodEventsService cursor codec', () => {
  it('round-trips (occurredAt, id)', () => {
    const encoded = encodeCursor(NOW, 'ple_abc');
    const decoded = decodeCursor(encoded);
    expect(decoded?.occurredAt.getTime()).toBe(NOW.getTime());
    expect(decoded?.id).toBe('ple_abc');
  });

  it('returns null on malformed inputs', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('!!!')).toBeNull();
  });
});

describe('AdminPeriodEventsService.listByPeriod', () => {
  it('returns period_not_found when period name does not resolve', async () => {
    const prisma = buildPrismaStub({ periodFindUnique: async () => null });
    const service = new AdminPeriodEventsService(prisma);
    const result = await service.listByPeriod({ periodName: '1999-01', limit: 25 });
    expect(result.kind).toBe('period_not_found');
  });

  it('returns empty page for an existing period with no events', async () => {
    const prisma = buildPrismaStub({
      periodFindUnique: async () => ({ id: 'per_a', name: '2026-05' }),
      eventFindMany: async () => [],
    });
    const service = new AdminPeriodEventsService(prisma);
    const result = await service.listByPeriod({ periodName: '2026-05', limit: 25 });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.page.events).toEqual([]);
    expect(result.page.nextCursor).toBeNull();
  });

  it('emits nextCursor when page is full', async () => {
    const prisma = buildPrismaStub({
      periodFindUnique: async () => ({ id: 'per_a', name: '2026-05' }),
      eventFindMany: async () => [
        buildEvent({ id: 'ple_1', occurredAt: NOW }),
        buildEvent({ id: 'ple_2', occurredAt: new Date(NOW.getTime() - 1000) }),
        buildEvent({ id: 'ple_3', occurredAt: new Date(NOW.getTime() - 2000) }),
      ],
    });
    const service = new AdminPeriodEventsService(prisma);
    const result = await service.listByPeriod({ periodName: '2026-05', limit: 2 });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.page.events).toHaveLength(2);
    expect(result.page.nextCursor).not.toBeNull();
    const decoded = decodeCursor(result.page.nextCursor!);
    expect(decoded?.id).toBe('ple_2');
  });

  it('denormalises periodName onto every event row', async () => {
    const prisma = buildPrismaStub({
      periodFindUnique: async () => ({ id: 'per_a', name: '2026-05' }),
      eventFindMany: async () => [buildEvent({ id: 'ple_x' })],
    });
    const service = new AdminPeriodEventsService(prisma);
    const result = await service.listByPeriod({ periodName: '2026-05', limit: 25 });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.page.events[0]?.periodName).toBe('2026-05');
  });

  it('forwards cursor predicate when supplied', async () => {
    const findMany = vi.fn(async (_args: unknown): Promise<PersistedEventRow[]> => []);
    const prisma = buildPrismaStub({
      periodFindUnique: async () => ({ id: 'per_a', name: '2026-05' }),
      eventFindMany: findMany,
    });
    const service = new AdminPeriodEventsService(prisma);
    await service.listByPeriod({
      periodName: '2026-05',
      cursor: encodeCursor(NOW, 'ple_anchor'),
      limit: 25,
    });
    const callArgs = findMany.mock.calls.at(0)?.[0] as {
      where: { periodId: string; OR?: unknown[] };
    };
    expect(callArgs.where.periodId).toBe('per_a');
    expect(callArgs.where.OR).toBeDefined();
  });
});
