import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type {
  ConciergeTicketRecord,
  TriggerEmergencyAssistanceRequest,
} from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import { EmergencyService } from '../services/emergency.service';
import { EmergencyController } from './emergency.controller';

const T0 = '2026-06-01T09:00:00.000Z';

function buildRecord(overrides: Partial<ConciergeTicketRecord> = {}): ConciergeTicketRecord {
  return {
    id: 'tk_emergency_1',
    householdId: 'hh_1',
    kind: 'emergency_assistance',
    status: 'escalated',
    subject: 'Emergency assistance — Medical concern',
    body: "Mom isn't answering.",
    requestedDate: null,
    partySize: null,
    theme: null,
    slaDueAt: T0,
    assignedToUserId: 'user_primary',
    escalationPath: 'emergency_on_call',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

interface FakeService {
  triggerEmergency: ReturnType<typeof vi.fn>;
}

function buildController(overrides: Partial<FakeService> = {}): {
  controller: EmergencyController;
  service: FakeService;
} {
  const service: FakeService = {
    triggerEmergency: vi.fn(async (): Promise<ConciergeTicketRecord> => buildRecord()),
    ...overrides,
  };
  const controller = new EmergencyController(service as unknown as EmergencyService);
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

const VALID_BODY: TriggerEmergencyAssistanceRequest = {
  category: 'medical',
  note: "Mom isn't answering.",
};

describe('EmergencyController.trigger', () => {
  it('triggers for the household resolved from the token scope', async () => {
    const { controller, service } = buildController();

    const response = await controller.trigger(VALID_BODY, householdRequest('hh_42'));

    expect(response.ticket.kind).toBe('emergency_assistance');
    expect(response.ticket.status).toBe('escalated');
    expect(service.triggerEmergency).toHaveBeenCalledWith(
      expect.objectContaining({
        householdId: 'hh_42',
        category: 'medical',
        note: "Mom isn't answering.",
      }),
    );
  });

  it('normalises an omitted note to null at the service boundary', async () => {
    const { controller, service } = buildController();

    await controller.trigger({ category: 'safety' }, householdRequest());

    expect(service.triggerEmergency).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'safety', note: null }),
    );
  });

  it('rejects a non-household (admin/global) actor with 400', async () => {
    const { controller } = buildController();

    await expect(controller.trigger(VALID_BODY, adminRequest())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws 401 when no request context is attached', async () => {
    const { controller } = buildController();

    await expect(
      controller.trigger(VALID_BODY, {} as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
