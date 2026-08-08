import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type {
  ConciergeTicketRecord,
  SubmitConciergeRequestRequest,
} from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import { TicketsService } from '../services/tickets.service';
import { TicketsController } from './tickets.controller';

const T0 = '2026-06-01T09:00:00.000Z';

function buildRecord(overrides: Partial<ConciergeTicketRecord> = {}): ConciergeTicketRecord {
  return {
    id: 'tk_1',
    householdId: 'hh_1',
    kind: 'holiday_dinner',
    status: 'assigned',
    subject: 'Thanksgiving supper',
    body: 'A small traditional dinner.',
    requestedDate: '2026-11-26',
    partySize: 6,
    theme: 'Traditional',
    slaDueAt: T0,
    assignedToUserId: 'user_primary',
    escalationPath: 'standard',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

interface FakeService {
  submitRequest: ReturnType<typeof vi.fn>;
  listForHousehold: ReturnType<typeof vi.fn>;
}

function buildController(overrides: Partial<FakeService> = {}): {
  controller: TicketsController;
  service: FakeService;
} {
  const service: FakeService = {
    submitRequest: vi.fn(async (): Promise<ConciergeTicketRecord> => buildRecord()),
    listForHousehold: vi.fn(async (): Promise<readonly ConciergeTicketRecord[]> => []),
    ...overrides,
  };
  const controller = new TicketsController(service as unknown as TicketsService);
  return { controller, service };
}

function householdRequest(householdId = 'hh_1'): RequestWithContext {
  const ctx: RequestContext = {
    userId: 'user_family',
    mfaVerified: false,
    roles: [],
    tenantScope: { type: 'household', householdId },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

function adminRequest(): RequestWithContext {
  const ctx: RequestContext = {
    userId: 'user_admin',
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

const VALID_BODY: SubmitConciergeRequestRequest = {
  kind: 'holiday_dinner',
  subject: 'Thanksgiving supper',
  body: 'A small traditional dinner.',
  requestedDate: '2026-11-26',
  partySize: 6,
  theme: 'Traditional',
};

describe('TicketsController.submit', () => {
  it('submits the request for the household resolved from the token scope', async () => {
    const { controller, service } = buildController();

    const response = await controller.submit(VALID_BODY, householdRequest('hh_42'));

    expect(response.ticket.id).toBe('tk_1');
    expect(service.submitRequest).toHaveBeenCalledWith(
      expect.objectContaining({ householdId: 'hh_42', kind: 'holiday_dinner' }),
    );
  });

  it('normalises omitted optional fields to null at the service boundary', async () => {
    const { controller, service } = buildController();

    await controller.submit(
      { kind: 'custom_request', subject: 'A quiet tea', body: 'Afternoon tea, please.' },
      householdRequest(),
    );

    expect(service.submitRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestedDate: null, partySize: null, theme: null }),
    );
  });

  it('rejects a non-household (admin/global) actor with 400', async () => {
    const { controller } = buildController();

    await expect(controller.submit(VALID_BODY, adminRequest())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws 401 when no request context is attached', async () => {
    const { controller } = buildController();

    await expect(
      controller.submit(VALID_BODY, {} as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('TicketsController.listMine', () => {
  it('lists the household requests resolved from the token scope', async () => {
    const { controller, service } = buildController({
      listForHousehold: vi.fn(async () => [
        buildRecord(),
        buildRecord({ id: 'tk_2', status: 'open', assignedToUserId: null }),
      ]),
    });

    const response = await controller.listMine({ limit: 50 }, householdRequest('hh_7'));

    expect(response.tickets).toHaveLength(2);
    expect(service.listForHousehold).toHaveBeenCalledWith({ householdId: 'hh_7', limit: 50 });
  });

  it('returns an empty list when the household has no requests', async () => {
    const { controller } = buildController();

    const response = await controller.listMine({ limit: 50 }, householdRequest());

    expect(response.tickets).toEqual([]);
  });

  it('rejects a non-household actor with 400', async () => {
    const { controller } = buildController();

    await expect(controller.listMine({ limit: 50 }, adminRequest())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws 401 when no request context is attached', async () => {
    const { controller } = buildController();

    await expect(
      controller.listMine({ limit: 50 }, {} as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
