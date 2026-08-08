import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type {
  ConciergeAssignmentRecord,
  CreateConciergeAssignmentRequest,
} from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';

import {
  AssignmentsService,
  type CreateAssignmentFailure,
  type EndAssignmentOutcome,
} from '../services/assignments.service';
import { err, ok, type Result } from '../services/result';
import { AssignmentsController } from './assignments.controller';

const T0 = '2026-06-01T09:00:00.000Z';

function buildRecord(
  overrides: Partial<ConciergeAssignmentRecord> = {},
): ConciergeAssignmentRecord {
  return {
    id: 'ca_1',
    householdId: 'hh_1',
    primaryConciergeUserId: 'user_primary',
    primaryConciergeDisplayName: 'Avery Concierge',
    backupConciergeUserId: null,
    backupConciergeDisplayName: null,
    status: 'active',
    assignedByUserId: 'user_admin',
    startedAt: T0,
    endedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

interface FakeService {
  create: ReturnType<typeof vi.fn>;
  getActiveForHousehold: ReturnType<typeof vi.fn>;
  listForHousehold: ReturnType<typeof vi.fn>;
  endAssignment: ReturnType<typeof vi.fn>;
}

function buildController(overrides: Partial<FakeService> = {}): {
  controller: AssignmentsController;
  service: FakeService;
} {
  const service: FakeService = {
    create: vi.fn(
      async (): Promise<Result<ConciergeAssignmentRecord, CreateAssignmentFailure>> =>
        ok(buildRecord()),
    ),
    getActiveForHousehold: vi.fn(async (): Promise<ConciergeAssignmentRecord | null> => null),
    listForHousehold: vi.fn(async (): Promise<readonly ConciergeAssignmentRecord[]> => []),
    endAssignment: vi.fn(async (): Promise<EndAssignmentOutcome> => 'ended'),
    ...overrides,
  };
  const controller = new AssignmentsController(service as unknown as AssignmentsService);
  return { controller, service };
}

function adminRequest(userId = 'user_admin'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
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

const VALID_BODY: CreateConciergeAssignmentRequest = {
  householdId: 'hh_1',
  primaryConciergeUserId: 'user_primary',
  primaryConciergeDisplayName: 'Avery Concierge',
};

describe('AssignmentsController.create', () => {
  it('creates the assignment and returns the wrapped record', async () => {
    const { controller, service } = buildController();

    const response = await controller.create(VALID_BODY, adminRequest());

    expect(response.assignment.id).toBe('ca_1');
    expect(service.create).toHaveBeenCalledTimes(1);
  });

  it('stamps the attributing admin from the request context, not the body', async () => {
    const { controller, service } = buildController();

    await controller.create(
      { ...VALID_BODY, assignedByUserId: 'user_smuggled' },
      adminRequest('user_real_admin'),
    );

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ assignedByUserId: 'user_real_admin' }),
    );
  });

  it('normalises an omitted backup to null at the service boundary', async () => {
    const { controller, service } = buildController();

    await controller.create(VALID_BODY, adminRequest());

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ backupConciergeUserId: null, backupConciergeDisplayName: null }),
    );
  });

  it('maps a single-active conflict to 409', async () => {
    const { controller } = buildController({
      create: vi.fn(async () => err({ reason: 'conflict' as const })),
    });

    await expect(controller.create(VALID_BODY, adminRequest())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('throws 401 when no request context is attached', async () => {
    const { controller } = buildController();

    await expect(
      controller.create(VALID_BODY, {} as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AssignmentsController.getMine', () => {
  it('returns the active assignment for the household resolved from the token scope', async () => {
    const { controller, service } = buildController({
      getActiveForHousehold: vi.fn(async () => buildRecord()),
    });

    const response = await controller.getMine(householdRequest('hh_42'));

    expect(response.householdId).toBe('hh_42');
    expect(response.assignment?.id).toBe('ca_1');
    expect(service.getActiveForHousehold).toHaveBeenCalledWith('hh_42');
  });

  it('returns a null assignment when the household has no dedicated concierge', async () => {
    const { controller } = buildController();

    const response = await controller.getMine(householdRequest('hh_1'));

    expect(response.assignment).toBeNull();
    expect(response.householdId).toBe('hh_1');
  });

  it('rejects a non-household (admin/global) actor with 400', async () => {
    const { controller } = buildController();

    await expect(controller.getMine(adminRequest())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws 401 when no request context is attached', async () => {
    const { controller } = buildController();

    await expect(controller.getMine({} as unknown as RequestWithContext)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('AssignmentsController.list', () => {
  it('returns the household assignment history', async () => {
    const { controller, service } = buildController({
      listForHousehold: vi.fn(async () => [
        buildRecord(),
        buildRecord({ id: 'ca_2', status: 'ended', endedAt: T0 }),
      ]),
    });

    const response = await controller.list({ householdId: 'hh_1', limit: 50 });

    expect(response.assignments).toHaveLength(2);
    expect(service.listForHousehold).toHaveBeenCalledWith({
      householdId: 'hh_1',
      activeOnly: false,
      limit: 50,
    });
  });

  it('forwards the activeOnly flag', async () => {
    const { controller, service } = buildController();

    await controller.list({ householdId: 'hh_1', activeOnly: true, limit: 10 });

    expect(service.listForHousehold).toHaveBeenCalledWith({
      householdId: 'hh_1',
      activeOnly: true,
      limit: 10,
    });
  });
});

describe('AssignmentsController.end', () => {
  it('returns the ended outcome', async () => {
    const { controller } = buildController();

    const response = await controller.end('ca_1');

    expect(response.outcome).toBe('ended');
    expect(response.assignmentId).toBe('ca_1');
  });

  it('returns not_found verbatim (idempotent)', async () => {
    const { controller } = buildController({
      endAssignment: vi.fn(async () => 'not_found' as const),
    });

    const response = await controller.end('ca_missing');

    expect(response.outcome).toBe('not_found');
  });
});
