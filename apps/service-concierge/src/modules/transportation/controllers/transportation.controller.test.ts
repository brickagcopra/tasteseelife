import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { ConciergeTransportationRequestRecord } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import {
  TransportationService,
  type ScheduleRideOutcome,
  type UpdateRideOutcome,
} from '../services/transportation.service';
import { TransportationController } from './transportation.controller';

const PICKUP = '2026-06-01T14:00:00.000Z';

function buildRide(
  overrides: Partial<ConciergeTransportationRequestRecord> = {},
): ConciergeTransportationRequestRecord {
  return {
    id: 'ride_1',
    householdId: 'hh_1',
    ticketId: null,
    status: 'requested',
    externalProvider: 'manual',
    pickupAddress: '101 Park Ave',
    dropoffAddress: 'Mount Sinai',
    scheduledPickupAt: PICKUP,
    purpose: 'Cardiology follow-up',
    riderName: 'Eleanor',
    externalReference: null,
    externalStatus: null,
    notes: null,
    createdByUserId: 'user_concierge',
    createdAt: PICKUP,
    updatedAt: PICKUP,
    ...overrides,
  };
}

interface FakeService {
  listRides: ReturnType<typeof vi.fn>;
  scheduleRide: ReturnType<typeof vi.fn>;
  updateRide: ReturnType<typeof vi.fn>;
}

function buildController(overrides: Partial<FakeService> = {}): {
  controller: TransportationController;
  service: FakeService;
} {
  const service: FakeService = {
    listRides: vi.fn(
      async (): Promise<readonly ConciergeTransportationRequestRecord[]> => [buildRide()],
    ),
    scheduleRide: vi.fn(
      async (): Promise<ScheduleRideOutcome> => ({ ok: true, request: buildRide() }),
    ),
    updateRide: vi.fn(
      async (): Promise<UpdateRideOutcome> => ({
        ok: true,
        request: buildRide({ status: 'scheduled' }),
      }),
    ),
    ...overrides,
  };
  const controller = new TransportationController(service as unknown as TransportationService);
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
  pickupAddress: '101 Park Ave',
  dropoffAddress: 'Mount Sinai',
  scheduledPickupAt: PICKUP,
  externalProvider: 'manual',
  status: 'requested',
} as const;

describe('TransportationController.list', () => {
  it('forwards the query filters and returns wrapped requests', async () => {
    const { controller, service } = buildController();
    const result = await controller.list({
      householdId: 'hh_9',
      ticketId: 'tk_2',
      status: 'scheduled',
      externalProvider: 'uber_health',
      upcomingOnly: true,
      limit: 25,
    });
    expect(result.requests).toHaveLength(1);
    expect(service.listRides).toHaveBeenCalledWith({
      householdId: 'hh_9',
      ticketId: 'tk_2',
      status: 'scheduled',
      externalProvider: 'uber_health',
      upcomingOnly: true,
      limit: 25,
    });
  });
});

describe('TransportationController.schedule', () => {
  it('schedules and stamps the actor from the token', async () => {
    const { controller, service } = buildController();
    const result = await controller.schedule({ ...scheduleBody }, opsRequest('user_actor'));
    expect(result.request.id).toBe('ride_1');
    expect(service.scheduleRide).toHaveBeenCalledWith({
      ...scheduleBody,
      actorUserId: 'user_actor',
    });
  });

  it('throws 404 on ticket_not_found', async () => {
    const { controller } = buildController({
      scheduleRide: vi.fn(
        async (): Promise<ScheduleRideOutcome> => ({ ok: false, reason: 'ticket_not_found' }),
      ),
    });
    await expect(
      controller.schedule({ ...scheduleBody, ticketId: 'nope' }, opsRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 409 on ticket_household_mismatch', async () => {
    const { controller } = buildController({
      scheduleRide: vi.fn(
        async (): Promise<ScheduleRideOutcome> => ({
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

describe('TransportationController.update', () => {
  it('updates and stamps the actor', async () => {
    const { controller, service } = buildController();
    const result = await controller.update(
      'ride_1',
      { status: 'scheduled' },
      opsRequest('user_actor'),
    );
    expect(result.request.status).toBe('scheduled');
    expect(service.updateRide).toHaveBeenCalledWith({
      status: 'scheduled',
      requestId: 'ride_1',
      actorUserId: 'user_actor',
    });
  });

  it('throws 404 on not_found', async () => {
    const { controller } = buildController({
      updateRide: vi.fn(
        async (): Promise<UpdateRideOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.update('nope', { notes: 'x' }, opsRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws 409 on terminal', async () => {
    const { controller } = buildController({
      updateRide: vi.fn(
        async (): Promise<UpdateRideOutcome> => ({
          ok: false,
          reason: 'terminal',
          status: 'completed',
        }),
      ),
    });
    await expect(controller.update('ride_1', { notes: 'x' }, opsRequest())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('throws 409 on invalid_transition', async () => {
    const { controller } = buildController({
      updateRide: vi.fn(
        async (): Promise<UpdateRideOutcome> => ({
          ok: false,
          reason: 'invalid_transition',
          from: 'requested',
          to: 'completed',
        }),
      ),
    });
    await expect(
      controller.update('ride_1', { status: 'completed' }, opsRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws 401 when the request carries no context', async () => {
    const { controller } = buildController();
    await expect(
      controller.update('ride_1', { notes: 'x' }, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
