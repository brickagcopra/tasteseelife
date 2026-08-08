import { describe, expect, it } from 'vitest';

import {
  toLifecycleEventResponse,
  toPeriodResponse,
  type PersistedLifecycleEvent,
  type PersistedPeriod,
} from './period.mapper';

describe('toPeriodResponse', () => {
  it('maps an open period with null close fields', () => {
    const persisted: PersistedPeriod = {
      id: 'prd_abc',
      name: '2026-05',
      startDate: new Date('2026-05-01T00:00:00.000Z'),
      endDate: new Date('2026-05-31T00:00:00.000Z'),
      status: 'open',
      closedAt: null,
      closedByUserId: null,
      createdAt: new Date('2026-05-01T10:00:00.000Z'),
      updatedAt: new Date('2026-05-01T10:00:00.000Z'),
    };

    expect(toPeriodResponse(persisted)).toEqual({
      id: 'prd_abc',
      name: '2026-05',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      status: 'open',
      closedAt: null,
      closedByUserId: null,
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-01T10:00:00.000Z',
    });
  });

  it('maps a closed period with closedAt + closedByUserId', () => {
    const persisted: PersistedPeriod = {
      id: 'prd_apr',
      name: '2026-04',
      startDate: new Date('2026-04-01T00:00:00.000Z'),
      endDate: new Date('2026-04-30T00:00:00.000Z'),
      status: 'closed',
      closedAt: new Date('2026-05-05T15:00:00.000Z'),
      closedByUserId: 'usr_finance',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T15:00:00.000Z'),
    };

    const result = toPeriodResponse(persisted);
    expect(result.status).toBe('closed');
    expect(result.closedAt).toBe('2026-05-05T15:00:00.000Z');
    expect(result.closedByUserId).toBe('usr_finance');
  });

  it('formats startDate / endDate as YYYY-MM-DD regardless of timezone offset', () => {
    // Even if Prisma surfaces the Date as UTC midnight, the slice
    // operation keeps the locale-independent date portion.
    const persisted: PersistedPeriod = {
      id: 'prd_dec',
      name: '2026-12',
      startDate: new Date('2026-12-01T00:00:00.000Z'),
      endDate: new Date('2026-12-31T00:00:00.000Z'),
      status: 'open',
      closedAt: null,
      closedByUserId: null,
      createdAt: new Date('2026-12-01T00:00:00.000Z'),
      updatedAt: new Date('2026-12-01T00:00:00.000Z'),
    };
    const result = toPeriodResponse(persisted);
    expect(result.startDate).toBe('2026-12-01');
    expect(result.endDate).toBe('2026-12-31');
  });
});

describe('toLifecycleEventResponse', () => {
  it('maps a close event with denormalised periodName', () => {
    const persisted: PersistedLifecycleEvent = {
      id: 'evt_abc',
      periodId: 'prd_abc',
      kind: 'close',
      actorUserId: 'usr_finance',
      sourceEventId: 'evt_close_2026-05',
      reasonCode: 'monthly_close',
      description: 'May 2026 close',
      occurredAt: new Date('2026-06-05T15:00:00.000Z'),
      createdAt: new Date('2026-06-05T15:00:01.000Z'),
      period: { name: '2026-05' },
    };

    expect(toLifecycleEventResponse(persisted)).toEqual({
      id: 'evt_abc',
      periodId: 'prd_abc',
      periodName: '2026-05',
      kind: 'close',
      actorUserId: 'usr_finance',
      sourceEventId: 'evt_close_2026-05',
      reasonCode: 'monthly_close',
      description: 'May 2026 close',
      occurredAt: '2026-06-05T15:00:00.000Z',
      createdAt: '2026-06-05T15:00:01.000Z',
    });
  });

  it('maps a reopen event with null description', () => {
    const persisted: PersistedLifecycleEvent = {
      id: 'evt_reopen',
      periodId: 'prd_abc',
      kind: 'reopen',
      actorUserId: 'usr_finance',
      sourceEventId: 'evt_reopen_2026-04',
      reasonCode: 'late_invoice_adjustment',
      description: null,
      occurredAt: new Date('2026-06-10T09:30:00.000Z'),
      createdAt: new Date('2026-06-10T09:30:01.000Z'),
      period: { name: '2026-04' },
    };

    const result = toLifecycleEventResponse(persisted);
    expect(result.kind).toBe('reopen');
    expect(result.description).toBeNull();
    expect(result.periodName).toBe('2026-04');
  });
});
