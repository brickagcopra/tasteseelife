import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { AdPlacementRecord, AdSlotScheduleRecord } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import {
  SlotInventoryService,
  type CreateSlotScheduleOutcome,
  type GetSlotScheduleOutcome,
  type UpdateSlotScheduleOutcome,
} from '../services/slot-inventory.service';
import { SlotInventoryController } from './slot-inventory.controller';

const TS = '2026-06-15T00:00:00.000Z';

function placement(overrides: Partial<AdPlacementRecord> = {}): AdPlacementRecord {
  return {
    id: 'plc_1',
    slotCode: 'home_banner',
    supportedCreativeKinds: ['banner'],
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function schedule(overrides: Partial<AdSlotScheduleRecord> = {}): AdSlotScheduleRecord {
  return {
    id: 'sch_1',
    placementId: 'plc_1',
    campaignId: 'camp_1',
    status: 'scheduled',
    priority: 0,
    startAt: TS,
    endAt: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

interface FakeService {
  listPlacements: ReturnType<typeof vi.fn>;
  listSchedules: ReturnType<typeof vi.fn>;
  createSchedule: ReturnType<typeof vi.fn>;
  getSchedule: ReturnType<typeof vi.fn>;
  updateSchedule: ReturnType<typeof vi.fn>;
}

function build(overrides: Partial<FakeService> = {}): {
  controller: SlotInventoryController;
  service: FakeService;
} {
  const service: FakeService = {
    listPlacements: vi.fn(async (): Promise<readonly AdPlacementRecord[]> => [placement()]),
    listSchedules: vi.fn(async (): Promise<readonly AdSlotScheduleRecord[]> => [schedule()]),
    createSchedule: vi.fn(
      async (): Promise<CreateSlotScheduleOutcome> => ({ ok: true, schedule: schedule() }),
    ),
    getSchedule: vi.fn(
      async (): Promise<GetSlotScheduleOutcome> => ({ ok: true, schedule: schedule() }),
    ),
    updateSchedule: vi.fn(
      async (): Promise<UpdateSlotScheduleOutcome> => ({
        ok: true,
        schedule: schedule({ status: 'active' }),
      }),
    ),
    ...overrides,
  };
  const controller = new SlotInventoryController(service as unknown as SlotInventoryService);
  return { controller, service };
}

function adminRequest(userId = 'user_admin'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return {
    requestContext: ctx,
    ip: '203.0.113.9',
    headers: { 'user-agent': 'jest' },
  } as unknown as RequestWithContext;
}

describe('SlotInventoryController.listPlacements', () => {
  it('returns the seeded placements', async () => {
    const { controller } = build();
    const response = await controller.listPlacements();
    expect(response.placements).toHaveLength(1);
    expect(response.placements[0]?.slotCode).toBe('home_banner');
  });
});

describe('SlotInventoryController.listSchedules', () => {
  it('forwards the filters', async () => {
    const { controller, service } = build();
    const response = await controller.listSchedules({
      placementId: 'plc_1',
      campaignId: undefined,
      status: 'scheduled',
      limit: 50,
    });
    expect(response.schedules).toHaveLength(1);
    expect(service.listSchedules).toHaveBeenCalledWith({
      placementId: 'plc_1',
      campaignId: undefined,
      status: 'scheduled',
      limit: 50,
    });
  });
});

describe('SlotInventoryController.create', () => {
  const body = {
    placementId: 'plc_1',
    campaignId: 'camp_1',
    startAt: TS,
    priority: 0,
    status: 'scheduled' as const,
  };

  it('creates and attributes the actor from the token', async () => {
    const { controller, service } = build();
    const response = await controller.create(body, adminRequest('admin_42'));
    expect(response.schedule.id).toBe('sch_1');
    expect(service.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        ...body,
        actorUserId: 'admin_42',
        audit: expect.objectContaining({ actorUserId: 'admin_42' }),
      }),
    );
  });

  it.each(['placement_not_found', 'campaign_not_found'] as const)(
    'maps %s to 422',
    async (reason) => {
      const { controller } = build({ createSchedule: vi.fn(async () => ({ ok: false, reason })) });
      await expect(controller.create(body, adminRequest())).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    },
  );

  it('maps incompatible_creative_kind to 422 naming the supported + approved kinds', async () => {
    const { controller } = build({
      createSchedule: vi.fn(async () => ({
        ok: false,
        reason: 'incompatible_creative_kind',
        supportedKinds: ['sponsored_listing'],
        approvedKinds: ['banner'],
      })),
    });
    await expect(controller.create(body, adminRequest())).rejects.toMatchObject({
      response: {
        status: 422,
        detail: expect.stringContaining('sponsored_listing'),
      },
    });
  });

  it('rejects a request with no auth context', async () => {
    const { controller } = build();
    await expect(
      controller.create(body, { requestContext: undefined } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('SlotInventoryController.detail', () => {
  it('returns the schedule', async () => {
    const { controller } = build();
    const response = await controller.detail('sch_1');
    expect(response.schedule.id).toBe('sch_1');
  });

  it('maps not_found to 404', async () => {
    const { controller } = build({
      getSchedule: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
    });
    await expect(controller.detail('sch_x')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SlotInventoryController.update', () => {
  it('applies the update', async () => {
    const { controller } = build();
    const response = await controller.update('sch_1', { status: 'active' }, adminRequest());
    expect(response.schedule.status).toBe('active');
  });

  it('maps not_found to 404', async () => {
    const { controller } = build({
      updateSchedule: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
    });
    await expect(
      controller.update('sch_x', { status: 'active' }, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps an invalid transition to 409', async () => {
    const { controller } = build({
      updateSchedule: vi.fn(async () => ({
        ok: false,
        reason: 'invalid_transition',
        from: 'scheduled',
        to: 'completed',
      })),
    });
    await expect(
      controller.update('sch_1', { status: 'completed' }, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps an invalid window to 422', async () => {
    const { controller } = build({
      updateSchedule: vi.fn(async () => ({ ok: false, reason: 'invalid_window' })),
    });
    await expect(
      controller.update('sch_1', { startAt: '2026-09-01T00:00:00.000Z' }, adminRequest()),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
