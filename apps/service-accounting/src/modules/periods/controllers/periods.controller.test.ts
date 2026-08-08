import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';
import { describe, expect, it, vi } from 'vitest';

import type {
  GenerateCalendarOutput,
  PeriodCalendarService,
} from '../services/period-calendar.service';
import type {
  PeriodLifecycleService,
  PeriodLifecycleSuccess,
} from '../services/period-lifecycle.service';
import { PeriodsController } from './periods.controller';

import type { PeriodResponse } from '@taste-and-see/contracts';

function makeAuthedRequest(userId: string | null = 'usr_finance'): RequestWithContext {
  const req = {} as RequestWithContext;
  if (userId !== null) {
    Object.assign(req, {
      requestContext: {
        userId,
        mfaVerified: true,
        roles: [],
        tenantScope: { type: 'global' },
      },
    });
  }
  return req;
}

function makeLifecycleStub(): PeriodLifecycleService {
  return {
    close: vi.fn(),
    reopen: vi.fn(),
  } as unknown as PeriodLifecycleService;
}

function makeCalendarStub(): PeriodCalendarService {
  return {
    generateMonthly: vi.fn(),
    getByName: vi.fn(),
    list: vi.fn(),
  } as unknown as PeriodCalendarService;
}

const openPeriod: PeriodResponse = {
  id: 'prd_abc',
  name: '2026-05',
  startDate: '2026-05-01',
  endDate: '2026-05-31',
  status: 'open',
  closedAt: null,
  closedByUserId: null,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
};

const closedPeriod: PeriodResponse = {
  ...openPeriod,
  status: 'closed',
  closedAt: '2026-06-05T15:00:00.000Z',
  closedByUserId: 'usr_finance',
  updatedAt: '2026-06-05T15:00:00.000Z',
};

const closeSuccess: PeriodLifecycleSuccess = {
  period: closedPeriod,
  event: {
    id: 'evt_abc',
    periodId: 'prd_abc',
    periodName: '2026-05',
    kind: 'close',
    actorUserId: 'usr_finance',
    sourceEventId: 'evt_close_2026-05',
    reasonCode: 'monthly_close',
    description: null,
    occurredAt: '2026-06-05T15:00:00.000Z',
    createdAt: '2026-06-05T15:00:01.000Z',
  },
  result: 'closed',
};

const reopenSuccess: PeriodLifecycleSuccess = {
  period: { ...openPeriod, closedAt: '2026-06-05T15:00:00.000Z', closedByUserId: 'usr_finance' },
  event: {
    id: 'evt_reopen',
    periodId: 'prd_abc',
    periodName: '2026-05',
    kind: 'reopen',
    actorUserId: 'usr_finance',
    sourceEventId: 'evt_reopen_2026-05',
    reasonCode: 'late_adjust',
    description: null,
    occurredAt: '2026-06-10T09:30:00.000Z',
    createdAt: '2026-06-10T09:30:01.000Z',
  },
  result: 'reopened',
};

describe('PeriodsController.listPeriods', () => {
  it('returns the calendar service output, wrapped in the response shape', async () => {
    const calendar = makeCalendarStub();
    vi.mocked(calendar.list).mockResolvedValue({
      periods: [openPeriod],
      nextCursor: null,
    });
    const controller = new PeriodsController(makeLifecycleStub(), calendar);

    const result = await controller.listPeriods({});
    expect(result.periods).toEqual([openPeriod]);
    expect(result.nextCursor).toBeNull();
    expect(calendar.list).toHaveBeenCalledWith({ limit: 50 });
  });

  it('forwards status + cursor to the calendar service', async () => {
    const calendar = makeCalendarStub();
    vi.mocked(calendar.list).mockResolvedValue({
      periods: [closedPeriod],
      nextCursor: '2026-04-01',
    });
    const controller = new PeriodsController(makeLifecycleStub(), calendar);

    await controller.listPeriods({ status: 'closed', cursor: 'c_2026-05', limit: 25 });
    expect(calendar.list).toHaveBeenCalledWith({
      status: 'closed',
      cursor: 'c_2026-05',
      limit: 25,
    });
  });
});

describe('PeriodsController.getPeriod', () => {
  it('returns the period when found', async () => {
    const calendar = makeCalendarStub();
    vi.mocked(calendar.getByName).mockResolvedValue(openPeriod);
    const controller = new PeriodsController(makeLifecycleStub(), calendar);

    const result = await controller.getPeriod('2026-05');
    expect(result).toEqual(openPeriod);
  });

  it('throws NotFoundException when the period is unknown', async () => {
    const calendar = makeCalendarStub();
    vi.mocked(calendar.getByName).mockResolvedValue(null);
    const controller = new PeriodsController(makeLifecycleStub(), calendar);

    await expect(controller.getPeriod('2099-12')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects with 422 when the period name is malformed', async () => {
    const controller = new PeriodsController(makeLifecycleStub(), makeCalendarStub());
    await expect(controller.getPeriod('not-a-period')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});

describe('PeriodsController.generatePeriods', () => {
  it('returns the generator output shape on success', async () => {
    const calendar = makeCalendarStub();
    const output: GenerateCalendarOutput = {
      startYearMonth: '2026-05',
      endYearMonth: '2026-06',
      requestedCount: 2,
      createdCount: 2,
      existedCount: 0,
      created: [openPeriod, { ...openPeriod, name: '2026-06' }],
      existed: [],
    };
    vi.mocked(calendar.generateMonthly).mockResolvedValue({
      ok: true,
      value: output,
    } as never);
    const controller = new PeriodsController(makeLifecycleStub(), calendar);

    const result = await controller.generatePeriods(
      { startYearMonth: '2026-05', endYearMonth: '2026-06' },
      makeAuthedRequest(),
    );
    expect(result.createdCount).toBe(2);
    expect(result.created).toHaveLength(2);
    expect(result.existed).toEqual([]);
  });

  it('maps range_inverted to 422', async () => {
    const calendar = makeCalendarStub();
    vi.mocked(calendar.generateMonthly).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'range_inverted',
        startYearMonth: '2026-12',
        endYearMonth: '2026-05',
      },
    } as never);
    const controller = new PeriodsController(makeLifecycleStub(), calendar);

    await expect(
      controller.generatePeriods(
        { startYearMonth: '2026-12', endYearMonth: '2026-05' },
        makeAuthedRequest(),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps range_exceeds_cap to 422', async () => {
    const calendar = makeCalendarStub();
    vi.mocked(calendar.generateMonthly).mockResolvedValue({
      ok: false,
      failure: { kind: 'range_exceeds_cap', requestedCount: 120, maxCount: 60 },
    } as never);
    const controller = new PeriodsController(makeLifecycleStub(), calendar);

    await expect(
      controller.generatePeriods(
        { startYearMonth: '2026-01', endYearMonth: '2036-01' },
        makeAuthedRequest(),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rejects with 401 when there is no requestContext', async () => {
    const calendar = makeCalendarStub();
    const controller = new PeriodsController(makeLifecycleStub(), calendar);
    await expect(
      controller.generatePeriods(
        { startYearMonth: '2026-05', endYearMonth: '2026-05' },
        makeAuthedRequest(null),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('carries the Idempotent metadata', () => {
    const metadata = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      PeriodsController.prototype.generatePeriods,
    );
    expect(metadata).toBeDefined();
  });
});

describe('PeriodsController.closePeriod', () => {
  it('closes a period and returns the lifecycle response', async () => {
    const lifecycle = makeLifecycleStub();
    vi.mocked(lifecycle.close).mockResolvedValue({
      ok: true,
      value: closeSuccess,
    } as never);
    const controller = new PeriodsController(lifecycle, makeCalendarStub());

    const result = await controller.closePeriod(
      '2026-05',
      {
        sourceEventId: 'evt_close_2026-05',
        occurredAt: '2026-06-05T15:00:00.000Z',
        reasonCode: 'monthly_close',
      },
      makeAuthedRequest(),
    );
    expect(result.period.status).toBe('closed');
    expect(result.event.kind).toBe('close');
    expect(result.result).toBe('closed');
    expect(lifecycle.close).toHaveBeenCalledWith({
      periodName: '2026-05',
      actorUserId: 'usr_finance',
      sourceEventId: 'evt_close_2026-05',
      reasonCode: 'monthly_close',
      description: null,
      occurredAt: new Date('2026-06-05T15:00:00.000Z'),
    });
  });

  it('defaults occurredAt to now() when omitted', async () => {
    const lifecycle = makeLifecycleStub();
    vi.mocked(lifecycle.close).mockResolvedValue({
      ok: true,
      value: closeSuccess,
    } as never);
    const controller = new PeriodsController(lifecycle, makeCalendarStub());

    const before = new Date();
    await controller.closePeriod(
      '2026-05',
      { sourceEventId: 'evt_x', reasonCode: 'monthly_close' },
      makeAuthedRequest(),
    );
    const after = new Date();

    const args = vi.mocked(lifecycle.close).mock.calls[0]?.[0];
    expect(args?.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(args?.occurredAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('maps period_not_found to 404', async () => {
    const lifecycle = makeLifecycleStub();
    vi.mocked(lifecycle.close).mockResolvedValue({
      ok: false,
      failure: { kind: 'period_not_found', periodName: '2026-05' },
    } as never);
    const controller = new PeriodsController(lifecycle, makeCalendarStub());

    await expect(
      controller.closePeriod(
        '2026-05',
        { sourceEventId: 'evt_x', reasonCode: 'monthly_close' },
        makeAuthedRequest(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps period_already_closed to 409', async () => {
    const lifecycle = makeLifecycleStub();
    vi.mocked(lifecycle.close).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'period_already_closed',
        periodId: 'prd_abc',
        periodName: '2026-05',
      },
    } as never);
    const controller = new PeriodsController(lifecycle, makeCalendarStub());

    await expect(
      controller.closePeriod(
        '2026-05',
        { sourceEventId: 'evt_x', reasonCode: 'monthly_close' },
        makeAuthedRequest(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps idempotency_payload_drift to 409', async () => {
    const lifecycle = makeLifecycleStub();
    vi.mocked(lifecycle.close).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'idempotency_payload_drift',
        sourceEventId: 'evt_shared',
        storedKind: 'close',
        storedPeriodId: 'prd_other',
      },
    } as never);
    const controller = new PeriodsController(lifecycle, makeCalendarStub());

    await expect(
      controller.closePeriod(
        '2026-05',
        { sourceEventId: 'evt_shared', reasonCode: 'monthly_close' },
        makeAuthedRequest(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects with 401 when requestContext is missing', async () => {
    const lifecycle = makeLifecycleStub();
    const controller = new PeriodsController(lifecycle, makeCalendarStub());

    await expect(
      controller.closePeriod(
        '2026-05',
        { sourceEventId: 'evt_x', reasonCode: 'monthly_close' },
        makeAuthedRequest(null),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects with 422 when the periodName is malformed', async () => {
    const controller = new PeriodsController(makeLifecycleStub(), makeCalendarStub());
    await expect(
      controller.closePeriod(
        'not-a-period',
        { sourceEventId: 'evt_x', reasonCode: 'monthly_close' },
        makeAuthedRequest(),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('carries the Idempotent metadata', () => {
    const metadata = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      PeriodsController.prototype.closePeriod,
    );
    expect(metadata).toBeDefined();
  });
});

describe('PeriodsController.reopenPeriod', () => {
  it('reopens a period and returns the lifecycle response', async () => {
    const lifecycle = makeLifecycleStub();
    vi.mocked(lifecycle.reopen).mockResolvedValue({
      ok: true,
      value: reopenSuccess,
    } as never);
    const controller = new PeriodsController(lifecycle, makeCalendarStub());

    const result = await controller.reopenPeriod(
      '2026-05',
      {
        sourceEventId: 'evt_reopen_2026-05',
        occurredAt: '2026-06-10T09:30:00.000Z',
        reasonCode: 'late_adjust',
      },
      makeAuthedRequest(),
    );
    expect(result.period.status).toBe('open');
    expect(result.event.kind).toBe('reopen');
    expect(result.result).toBe('reopened');
  });

  it('maps period_not_closed to 409', async () => {
    const lifecycle = makeLifecycleStub();
    vi.mocked(lifecycle.reopen).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'period_not_closed',
        periodId: 'prd_abc',
        periodName: '2026-05',
      },
    } as never);
    const controller = new PeriodsController(lifecycle, makeCalendarStub());

    await expect(
      controller.reopenPeriod(
        '2026-05',
        { sourceEventId: 'evt_x', reasonCode: 'late_adjust' },
        makeAuthedRequest(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('carries the Idempotent metadata', () => {
    const metadata = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      PeriodsController.prototype.reopenPeriod,
    );
    expect(metadata).toBeDefined();
  });
});
