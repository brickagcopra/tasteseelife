import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { ConciergeScheduledEventRecord } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';

import {
  ScheduledEventsService,
  type ScheduleEventOutcome,
  type UpdateEventOutcome,
} from '../services/scheduled-events.service';
import { ScheduledEventsController } from './scheduled-events.controller';

const START = '2026-06-01T18:00:00.000Z';
const END = '2026-06-01T20:30:00.000Z';

function buildEvent(
  overrides: Partial<ConciergeScheduledEventRecord> = {},
): ConciergeScheduledEventRecord {
  return {
    id: 'ev_1',
    householdId: 'hh_1',
    ticketId: null,
    kind: 'restaurant_reservation',
    status: 'proposed',
    title: 'Dinner at Carbone',
    venueName: 'Carbone',
    venueAddress: null,
    scheduledStart: START,
    scheduledEnd: END,
    partySize: 4,
    externalProvider: 'manual',
    externalReference: null,
    notes: null,
    createdByUserId: 'user_concierge',
    createdAt: START,
    updatedAt: START,
    ...overrides,
  };
}

interface FakeService {
  listEvents: ReturnType<typeof vi.fn>;
  scheduleEvent: ReturnType<typeof vi.fn>;
  updateEvent: ReturnType<typeof vi.fn>;
}

function buildController(overrides: Partial<FakeService> = {}): {
  controller: ScheduledEventsController;
  service: FakeService;
} {
  const service: FakeService = {
    listEvents: vi.fn(
      async (): Promise<readonly ConciergeScheduledEventRecord[]> => [buildEvent()],
    ),
    scheduleEvent: vi.fn(
      async (): Promise<ScheduleEventOutcome> => ({ ok: true, event: buildEvent() }),
    ),
    updateEvent: vi.fn(
      async (): Promise<UpdateEventOutcome> => ({
        ok: true,
        event: buildEvent({ status: 'confirmed' }),
      }),
    ),
    ...overrides,
  };
  const controller = new ScheduledEventsController(service as unknown as ScheduledEventsService);
  return { controller, service };
}

function opsRequest(userId = 'user_ops'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

const scheduleBody = {
  householdId: 'hh_1',
  kind: 'cultural_event',
  title: 'MoMA tour',
  scheduledStart: START,
  externalProvider: 'manual',
  status: 'proposed',
} as const;

describe('ScheduledEventsController.list', () => {
  it('forwards the query filters and returns wrapped events', async () => {
    const { controller, service } = buildController();
    const result = await controller.list({
      householdId: 'hh_9',
      ticketId: 'tk_2',
      status: 'confirmed',
      kind: 'group_outing',
      upcomingOnly: true,
      limit: 25,
    });
    expect(result.events).toHaveLength(1);
    expect(service.listEvents).toHaveBeenCalledWith({
      householdId: 'hh_9',
      ticketId: 'tk_2',
      status: 'confirmed',
      kind: 'group_outing',
      upcomingOnly: true,
      limit: 25,
    });
  });
});

describe('ScheduledEventsController.schedule', () => {
  it('schedules and stamps the actor from the token', async () => {
    const { controller, service } = buildController();
    const result = await controller.schedule({ ...scheduleBody }, opsRequest('user_actor'));
    expect(result.event.id).toBe('ev_1');
    expect(service.scheduleEvent).toHaveBeenCalledWith({
      ...scheduleBody,
      actorUserId: 'user_actor',
    });
  });

  it('throws 404 on ticket_not_found', async () => {
    const { controller } = buildController({
      scheduleEvent: vi.fn(
        async (): Promise<ScheduleEventOutcome> => ({ ok: false, reason: 'ticket_not_found' }),
      ),
    });
    await expect(
      controller.schedule({ ...scheduleBody, ticketId: 'nope' }, opsRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 409 on ticket_household_mismatch', async () => {
    const { controller } = buildController({
      scheduleEvent: vi.fn(
        async (): Promise<ScheduleEventOutcome> => ({
          ok: false,
          reason: 'ticket_household_mismatch',
        }),
      ),
    });
    await expect(
      controller.schedule({ ...scheduleBody, ticketId: 'tk_other' }, opsRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws 401 when the request carries no context', async () => {
    const { controller } = buildController();
    await expect(
      controller.schedule({ ...scheduleBody }, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('ScheduledEventsController.update', () => {
  it('updates and stamps the actor', async () => {
    const { controller, service } = buildController();
    const result = await controller.update(
      'ev_1',
      { status: 'confirmed' },
      opsRequest('user_actor'),
    );
    expect(result.event.status).toBe('confirmed');
    expect(service.updateEvent).toHaveBeenCalledWith({
      status: 'confirmed',
      eventId: 'ev_1',
      actorUserId: 'user_actor',
    });
  });

  it('throws 404 on not_found', async () => {
    const { controller } = buildController({
      updateEvent: vi.fn(
        async (): Promise<UpdateEventOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.update('nope', { notes: 'x' }, opsRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws 409 on terminal', async () => {
    const { controller } = buildController({
      updateEvent: vi.fn(
        async (): Promise<UpdateEventOutcome> => ({
          ok: false,
          reason: 'terminal',
          status: 'completed',
        }),
      ),
    });
    await expect(controller.update('ev_1', { notes: 'x' }, opsRequest())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('throws 409 on invalid_transition', async () => {
    const { controller } = buildController({
      updateEvent: vi.fn(
        async (): Promise<UpdateEventOutcome> => ({
          ok: false,
          reason: 'invalid_transition',
          from: 'proposed',
          to: 'completed',
        }),
      ),
    });
    await expect(
      controller.update('ev_1', { status: 'completed' }, opsRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws 409 on invalid_time_range', async () => {
    const { controller } = buildController({
      updateEvent: vi.fn(
        async (): Promise<UpdateEventOutcome> => ({ ok: false, reason: 'invalid_time_range' }),
      ),
    });
    await expect(
      controller.update('ev_1', { scheduledEnd: START }, opsRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws 401 when the request carries no context', async () => {
    const { controller } = buildController();
    await expect(
      controller.update('ev_1', { notes: 'x' }, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
