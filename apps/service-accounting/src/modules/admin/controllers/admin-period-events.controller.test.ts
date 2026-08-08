import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AdminPeriodEventsController } from './admin-period-events.controller';
import type {
  AdminPeriodEventsService,
  ListPeriodEventsResult,
} from '../services/admin-period-events.service';

const NOW = new Date('2026-05-18T12:00:00.000Z');

function buildService(opts: {
  listByPeriod?: () => Promise<ListPeriodEventsResult>;
}): AdminPeriodEventsService {
  return {
    listByPeriod: vi.fn(
      opts.listByPeriod ??
        (async () => ({
          kind: 'ok' as const,
          page: { events: [], nextCursor: null },
        })),
    ),
  } as unknown as AdminPeriodEventsService;
}

describe('AdminPeriodEventsController.list', () => {
  it('rejects malformed periodName with 422', async () => {
    const service = buildService({});
    const controller = new AdminPeriodEventsController(service);
    await expect(controller.list('not-a-period', { limit: 25 })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('returns 404 when the period does not exist', async () => {
    const service = buildService({
      listByPeriod: async () => ({
        kind: 'period_not_found' as const,
        periodName: '1999-01',
      }),
    });
    const controller = new AdminPeriodEventsController(service);
    await expect(controller.list('1999-01', { limit: 25 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns an empty events list for an existing period with no events', async () => {
    const service = buildService({});
    const controller = new AdminPeriodEventsController(service);
    const result = await controller.list('2026-05', { limit: 25 });
    expect(result.events).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('maps events onto the contract DTO with ISO timestamps', async () => {
    const service = buildService({
      listByPeriod: async () => ({
        kind: 'ok' as const,
        page: {
          events: [
            {
              id: 'ple_1',
              periodId: 'per_a',
              periodName: '2026-05',
              kind: 'close' as const,
              actorUserId: 'usr_admin',
              sourceEventId: 'evt_x',
              reasonCode: 'monthly_close',
              description: 'Routine.',
              occurredAt: NOW,
              createdAt: NOW,
            },
          ],
          nextCursor: 'cursor_x',
        },
      }),
    });
    const controller = new AdminPeriodEventsController(service);
    const result = await controller.list('2026-05', { limit: 25 });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.id).toBe('ple_1');
    expect(result.events[0]?.kind).toBe('close');
    expect(result.events[0]?.occurredAt).toBe(NOW.toISOString());
    expect(result.events[0]?.description).toBe('Routine.');
    expect(result.nextCursor).toBe('cursor_x');
  });

  it('forwards cursor + limit to the service', async () => {
    const spy = vi.fn(async () => ({
      kind: 'ok' as const,
      page: { events: [], nextCursor: null },
    }));
    const service = buildService({ listByPeriod: spy });
    const controller = new AdminPeriodEventsController(service);
    await controller.list('2026-05', { cursor: 'cur_x', limit: 42 });
    expect(spy).toHaveBeenCalledWith({
      periodName: '2026-05',
      cursor: 'cur_x',
      limit: 42,
    });
  });
});
