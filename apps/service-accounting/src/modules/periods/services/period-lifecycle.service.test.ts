import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { PeriodLifecycleService, type PeriodLifecycleRequest } from './period-lifecycle.service';

interface FakePeriodRow {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  status: 'open' | 'closed';
  closedAt: Date | null;
  closedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeLifecycleRow {
  id: string;
  periodId: string;
  kind: 'close' | 'reopen';
  actorUserId: string;
  sourceEventId: string;
  reasonCode: string;
  description: string | null;
  occurredAt: Date;
  createdAt: Date;
}

class PrismaUniqueViolation extends Error {
  public readonly code = 'P2002';
  public readonly meta: { target: string[] };
  constructor(target: string[]) {
    super('Unique constraint failed');
    this.name = 'PrismaClientKnownRequestError';
    this.meta = { target };
  }
}

class FakePrisma {
  public periodRows: FakePeriodRow[] = [];
  public lifecycleRows: FakeLifecycleRow[] = [];
  /** Forces a UNIQUE violation on the NEXT lifecycle create call. */
  public forceUniqueViolationOnNextLifecycleCreate: boolean = false;
  private autoId = 0;

  accountingPeriod = {
    findUnique: vi.fn(async (args: { where: { name?: string; id?: string }; select?: unknown }) => {
      const w = args.where;
      if ('name' in w && w.name !== undefined) {
        return this.periodRows.find((r) => r.name === w.name) ?? null;
      }
      if ('id' in w && w.id !== undefined) {
        return this.periodRows.find((r) => r.id === w.id) ?? null;
      }
      return null;
    }),
    findMany: vi.fn(),
    update: vi.fn(
      async (args: {
        where: { id: string };
        data: {
          status?: 'open' | 'closed';
          closedAt?: Date | null;
          closedByUserId?: string | null;
        };
        select?: unknown;
      }) => {
        const row = this.periodRows.find((r) => r.id === args.where.id);
        if (row === undefined) {
          throw new Error(`Period ${args.where.id} not found in fake prisma`);
        }
        if (args.data.status !== undefined) row.status = args.data.status;
        if ('closedAt' in args.data) row.closedAt = args.data.closedAt ?? null;
        if ('closedByUserId' in args.data) row.closedByUserId = args.data.closedByUserId ?? null;
        row.updatedAt = new Date();
        return row;
      },
    ),
  };

  periodLifecycleEvent = {
    findUnique: vi.fn(async (args: { where: { sourceEventId: string }; select?: unknown }) => {
      const row = this.lifecycleRows.find((r) => r.sourceEventId === args.where.sourceEventId);
      if (row === undefined) return null;
      const period = this.periodRows.find((p) => p.id === row.periodId);
      return {
        ...row,
        period,
      };
    }),
    create: vi.fn(
      async (args: {
        data: {
          periodId: string;
          kind: 'close' | 'reopen';
          actorUserId: string;
          sourceEventId: string;
          reasonCode: string;
          description: string | null;
          occurredAt: Date;
        };
        select?: unknown;
      }) => {
        if (this.forceUniqueViolationOnNextLifecycleCreate) {
          this.forceUniqueViolationOnNextLifecycleCreate = false;
          throw new PrismaUniqueViolation(['source_event_id']);
        }
        if (this.lifecycleRows.some((r) => r.sourceEventId === args.data.sourceEventId)) {
          throw new PrismaUniqueViolation(['source_event_id']);
        }
        this.autoId += 1;
        const row: FakeLifecycleRow = {
          id: `evt_${this.autoId}`,
          periodId: args.data.periodId,
          kind: args.data.kind,
          actorUserId: args.data.actorUserId,
          sourceEventId: args.data.sourceEventId,
          reasonCode: args.data.reasonCode,
          description: args.data.description,
          occurredAt: args.data.occurredAt,
          createdAt: new Date(),
        };
        this.lifecycleRows.push(row);
        return row;
      },
    ),
  };

  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function buildRequest(overrides: Partial<PeriodLifecycleRequest> = {}): PeriodLifecycleRequest {
  return {
    periodName: '2026-05',
    actorUserId: 'usr_finance',
    sourceEventId: 'evt_close_2026-05',
    reasonCode: 'monthly_close',
    description: null,
    occurredAt: new Date('2026-06-05T15:00:00.000Z'),
    ...overrides,
  };
}

function seedOpenPeriod(prisma: FakePrisma, overrides: Partial<FakePeriodRow> = {}): FakePeriodRow {
  const row: FakePeriodRow = {
    id: 'prd_abc',
    name: '2026-05',
    startDate: new Date('2026-05-01T00:00:00.000Z'),
    endDate: new Date('2026-05-31T00:00:00.000Z'),
    status: 'open',
    closedAt: null,
    closedByUserId: null,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
  prisma.periodRows.push(row);
  return row;
}

describe('PeriodLifecycleService.close', () => {
  let prisma: FakePrisma;
  let service: PeriodLifecycleService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new PeriodLifecycleService(prisma as unknown as PrismaService);
  });

  it('closes an open period and stamps closedAt + closedByUserId', async () => {
    seedOpenPeriod(prisma);
    const result = await service.close(buildRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toBe('closed');
    expect(result.value.period.status).toBe('closed');
    expect(result.value.period.closedAt).toBe('2026-06-05T15:00:00.000Z');
    expect(result.value.period.closedByUserId).toBe('usr_finance');
    expect(result.value.event.kind).toBe('close');
    expect(result.value.event.periodName).toBe('2026-05');
    expect(result.value.event.reasonCode).toBe('monthly_close');
    expect(prisma.lifecycleRows).toHaveLength(1);
  });

  it('persists the description when provided', async () => {
    seedOpenPeriod(prisma);
    const result = await service.close(buildRequest({ description: 'May 2026 monthly close.' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event.description).toBe('May 2026 monthly close.');
  });

  it('returns period_not_found when no period matches', async () => {
    const result = await service.close(buildRequest());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('period_not_found');
    if (result.failure.kind === 'period_not_found') {
      expect(result.failure.periodName).toBe('2026-05');
    }
    expect(prisma.lifecycleRows).toHaveLength(0);
  });

  it('returns period_already_closed when status is already closed (no replay match)', async () => {
    seedOpenPeriod(prisma, {
      status: 'closed',
      closedAt: new Date('2026-06-01T00:00:00.000Z'),
      closedByUserId: 'usr_other',
    });
    const result = await service.close(buildRequest());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('period_already_closed');
    if (result.failure.kind === 'period_already_closed') {
      expect(result.failure.periodName).toBe('2026-05');
    }
    expect(prisma.lifecycleRows).toHaveLength(0);
  });

  it('returns idempotent_replay on a repeat close with the same sourceEventId', async () => {
    seedOpenPeriod(prisma);
    const first = await service.close(buildRequest());
    expect(first.ok).toBe(true);

    // Second call with the same sourceEventId — replay the audit row.
    const second = await service.close(buildRequest());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.result).toBe('idempotent_replay');
    expect(prisma.lifecycleRows).toHaveLength(1);
  });

  it('returns idempotency_payload_drift when the same sourceEventId is reused for a different period', async () => {
    seedOpenPeriod(prisma);
    seedOpenPeriod(prisma, {
      id: 'prd_other',
      name: '2026-06',
      startDate: new Date('2026-06-01T00:00:00.000Z'),
      endDate: new Date('2026-06-30T00:00:00.000Z'),
    });

    const first = await service.close(buildRequest());
    expect(first.ok).toBe(true);

    // Same sourceEventId, different period → drift.
    const drift = await service.close(buildRequest({ periodName: '2026-06' }));
    expect(drift.ok).toBe(false);
    if (drift.ok) return;
    expect(drift.failure.kind).toBe('idempotency_payload_drift');
    if (drift.failure.kind === 'idempotency_payload_drift') {
      expect(drift.failure.storedKind).toBe('close');
    }
  });

  it('rolls back the audit row + status flip on race (P2002) and surfaces idempotent_replay', async () => {
    const period = seedOpenPeriod(prisma);
    // Pre-existing winning event with the same sourceEventId — simulates
    // a winning concurrent post that pre-populated the table after our
    // pre-flight findUnique returned null but before our create ran.
    const winner: FakeLifecycleRow = {
      id: 'evt_winner',
      periodId: period.id,
      kind: 'close',
      actorUserId: 'usr_finance',
      sourceEventId: 'evt_close_2026-05',
      reasonCode: 'monthly_close',
      description: null,
      occurredAt: new Date('2026-06-05T14:59:59.000Z'),
      createdAt: new Date('2026-06-05T15:00:00.000Z'),
    };

    // The pre-flight findUnique returns null on first call (no event)
    // and the winner on the post-P2002 refetch. Wire that with mock
    // implementation.
    let findUniqueCalls = 0;
    prisma.periodLifecycleEvent.findUnique = vi.fn(async () => {
      findUniqueCalls += 1;
      // Call 1 — pre-flight inside the service: no row yet.
      // Call 2 — post-P2002 refetch: winner exists.
      if (findUniqueCalls === 1) return null;
      const periodRow = prisma.periodRows.find((p) => p.id === winner.periodId);
      return { ...winner, period: periodRow };
    });
    prisma.forceUniqueViolationOnNextLifecycleCreate = true;

    const result = await service.close(buildRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toBe('idempotent_replay');
    expect(result.value.event.id).toBe('evt_winner');
    // The status flip was rolled back; the period remains open.
    expect((prisma.periodRows[0] as FakePeriodRow).status).toBe('open');
  });
});

describe('PeriodLifecycleService.reopen', () => {
  let prisma: FakePrisma;
  let service: PeriodLifecycleService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new PeriodLifecycleService(prisma as unknown as PrismaService);
  });

  it('reopens a closed period and preserves closedAt + closedByUserId', async () => {
    const closedAt = new Date('2026-06-01T00:00:00.000Z');
    seedOpenPeriod(prisma, {
      status: 'closed',
      closedAt,
      closedByUserId: 'usr_finance_prior',
    });

    const result = await service.reopen(
      buildRequest({
        sourceEventId: 'evt_reopen_2026-05',
        reasonCode: 'late_adjust',
        occurredAt: new Date('2026-06-10T09:30:00.000Z'),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toBe('reopened');
    expect(result.value.period.status).toBe('open');
    // The prior close is preserved as the audit record.
    expect(result.value.period.closedAt).toBe(closedAt.toISOString());
    expect(result.value.period.closedByUserId).toBe('usr_finance_prior');
    expect(result.value.event.kind).toBe('reopen');
  });

  it('returns period_not_closed when the period is currently open', async () => {
    seedOpenPeriod(prisma);
    const result = await service.reopen(buildRequest({ sourceEventId: 'evt_reopen_open_period' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('period_not_closed');
  });

  it('returns period_not_found when the period name is unknown', async () => {
    const result = await service.reopen(
      buildRequest({
        periodName: '2099-12',
        sourceEventId: 'evt_reopen_unknown',
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('period_not_found');
  });

  it('returns idempotent_replay on a repeated reopen with the same sourceEventId', async () => {
    seedOpenPeriod(prisma, {
      status: 'closed',
      closedAt: new Date('2026-06-01T00:00:00.000Z'),
      closedByUserId: 'usr_finance',
    });

    const first = await service.reopen(
      buildRequest({ sourceEventId: 'evt_reopen_2026-05', reasonCode: 'late_adjust' }),
    );
    expect(first.ok).toBe(true);

    // Period is now open again. Replay the reopen → idempotent_replay.
    const second = await service.reopen(
      buildRequest({ sourceEventId: 'evt_reopen_2026-05', reasonCode: 'late_adjust' }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.result).toBe('idempotent_replay');
    expect(prisma.lifecycleRows).toHaveLength(1);
  });

  it('returns idempotency_payload_drift when the same sourceEventId was previously used for close', async () => {
    seedOpenPeriod(prisma);

    const closed = await service.close(buildRequest({ sourceEventId: 'evt_shared_id' }));
    expect(closed.ok).toBe(true);

    const reopen = await service.reopen(
      buildRequest({ sourceEventId: 'evt_shared_id', reasonCode: 'late_adjust' }),
    );
    expect(reopen.ok).toBe(false);
    if (reopen.ok) return;
    expect(reopen.failure.kind).toBe('idempotency_payload_drift');
    if (reopen.failure.kind === 'idempotency_payload_drift') {
      expect(reopen.failure.storedKind).toBe('close');
    }
  });
});
