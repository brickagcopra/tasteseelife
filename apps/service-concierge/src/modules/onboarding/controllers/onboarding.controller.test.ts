import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  CONCIERGE_ONBOARDING_STEP_TEMPLATE,
  type ConciergeOnboardingDetailRecord,
  type ConciergeOnboardingRecord,
} from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import {
  OnboardingService,
  type CreateOnboardingOutcome,
  type UpdateOnboardingOutcome,
  type UpdateStepOutcome,
} from '../services/onboarding.service';
import { OnboardingController } from './onboarding.controller';

const NOW = '2026-05-26T15:00:00.000Z';

function buildDetail(
  overrides: Partial<ConciergeOnboardingDetailRecord> = {},
): ConciergeOnboardingDetailRecord {
  return {
    id: 'onb_1',
    householdId: 'hh_1',
    status: 'not_started',
    kickoffScheduledAt: null,
    notes: null,
    startedByUserId: 'user_ops',
    stepsTotal: 6,
    stepsCompleted: 0,
    completedAt: null,
    canceledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    steps: CONCIERGE_ONBOARDING_STEP_TEMPLATE.map((step) => ({
      stepKey: step.key,
      sortPosition: step.sortPosition,
      title: step.title,
      description: step.description,
      status: 'pending' as const,
      notes: null,
      completedAt: null,
      completedByUserId: null,
      updatedAt: NOW,
    })),
    ...overrides,
  };
}

function buildSummary(
  overrides: Partial<ConciergeOnboardingRecord> = {},
): ConciergeOnboardingRecord {
  return {
    id: 'onb_1',
    householdId: 'hh_1',
    status: 'in_progress',
    kickoffScheduledAt: null,
    notes: null,
    startedByUserId: 'user_ops',
    stepsTotal: 6,
    stepsCompleted: 2,
    completedAt: null,
    canceledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface FakeService {
  createOnboarding: ReturnType<typeof vi.fn>;
  listOnboardings: ReturnType<typeof vi.fn>;
  getOnboarding: ReturnType<typeof vi.fn>;
  getOnboardingForHousehold: ReturnType<typeof vi.fn>;
  updateOnboarding: ReturnType<typeof vi.fn>;
  updateStep: ReturnType<typeof vi.fn>;
}

function buildController(overrides: Partial<FakeService> = {}): {
  controller: OnboardingController;
  service: FakeService;
} {
  const service: FakeService = {
    createOnboarding: vi.fn(
      async (): Promise<CreateOnboardingOutcome> => ({ ok: true, onboarding: buildDetail() }),
    ),
    listOnboardings: vi.fn(async () => [buildSummary()]),
    getOnboarding: vi.fn(async () => buildDetail()),
    getOnboardingForHousehold: vi.fn(async () => buildDetail()),
    updateOnboarding: vi.fn(
      async (): Promise<UpdateOnboardingOutcome> => ({ ok: true, onboarding: buildDetail() }),
    ),
    updateStep: vi.fn(
      async (): Promise<UpdateStepOutcome> => ({ ok: true, onboarding: buildDetail() }),
    ),
    ...overrides,
  };
  const controller = new OnboardingController(service as unknown as OnboardingService);
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

function householdRequest(householdId = 'hh_1', userId = 'user_family'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'household', householdId },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

describe('OnboardingController.create', () => {
  it('forwards the body + actor and wraps the created onboarding', async () => {
    const { controller, service } = buildController();
    const result = await controller.create(
      { householdId: 'hh_9', kickoffScheduledAt: NOW, notes: 'evenings' },
      opsRequest('user_admin'),
    );
    expect(result.onboarding.id).toBe('onb_1');
    expect(service.createOnboarding).toHaveBeenCalledWith({
      householdId: 'hh_9',
      kickoffScheduledAt: NOW,
      notes: 'evenings',
      actorUserId: 'user_admin',
    });
  });

  it('maps already_exists to a 409', async () => {
    const { controller } = buildController({
      createOnboarding: vi.fn(
        async (): Promise<CreateOnboardingOutcome> => ({ ok: false, reason: 'already_exists' }),
      ),
    });
    await expect(controller.create({ householdId: 'hh_1' }, opsRequest())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('OnboardingController.list', () => {
  it('forwards the query filters', async () => {
    const { controller, service } = buildController();
    await controller.list({ householdId: 'hh_2', status: 'in_progress', limit: 25 });
    expect(service.listOnboardings).toHaveBeenCalledWith({
      householdId: 'hh_2',
      status: 'in_progress',
      limit: 25,
    });
  });
});

describe('OnboardingController.get', () => {
  it('returns the detail when found', async () => {
    const { controller } = buildController();
    const result = await controller.get('onb_1');
    expect(result.onboarding.id).toBe('onb_1');
  });

  it('throws 404 when missing', async () => {
    const { controller } = buildController({ getOnboarding: vi.fn(async () => null) });
    await expect(controller.get('onb_missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OnboardingController.update', () => {
  it('maps status=canceled in the body to cancel=true', async () => {
    const { controller, service } = buildController();
    await controller.update('onb_1', { status: 'canceled' }, opsRequest('user_admin'));
    expect(service.updateOnboarding).toHaveBeenCalledWith({
      onboardingId: 'onb_1',
      kickoffScheduledAt: undefined,
      notes: undefined,
      cancel: true,
      actorUserId: 'user_admin',
    });
  });

  it('passes cancel=false for a field-only edit', async () => {
    const { controller, service } = buildController();
    await controller.update('onb_1', { notes: null }, opsRequest());
    expect(service.updateOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({ cancel: false, notes: null }),
    );
  });

  it('maps not_found to 404', async () => {
    const { controller } = buildController({
      updateOnboarding: vi.fn(
        async (): Promise<UpdateOnboardingOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.update('onb_x', { notes: 'x' }, opsRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps terminal to 409', async () => {
    const { controller } = buildController({
      updateOnboarding: vi.fn(
        async (): Promise<UpdateOnboardingOutcome> => ({
          ok: false,
          reason: 'terminal',
          status: 'canceled',
        }),
      ),
    });
    await expect(controller.update('onb_1', { notes: 'x' }, opsRequest())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('OnboardingController.updateStep', () => {
  it('forwards the validated step key + status + actor', async () => {
    const { controller, service } = buildController();
    await controller.updateStep(
      'onb_1',
      'welcome_kickoff_call',
      { status: 'completed', notes: 'done' },
      opsRequest('user_c'),
    );
    expect(service.updateStep).toHaveBeenCalledWith({
      onboardingId: 'onb_1',
      stepKey: 'welcome_kickoff_call',
      status: 'completed',
      notes: 'done',
      actorUserId: 'user_c',
    });
  });

  it('rejects an unknown step key with 400', async () => {
    const { controller } = buildController();
    await expect(
      controller.updateStep('onb_1', 'order_groceries', { status: 'completed' }, opsRequest()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps not_found to 404', async () => {
    const { controller } = buildController({
      updateStep: vi.fn(
        async (): Promise<UpdateStepOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(
      controller.updateStep('onb_x', 'welcome_kickoff_call', { status: 'completed' }, opsRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps step_not_found to 404', async () => {
    const { controller } = buildController({
      updateStep: vi.fn(
        async (): Promise<UpdateStepOutcome> => ({ ok: false, reason: 'step_not_found' }),
      ),
    });
    await expect(
      controller.updateStep('onb_1', 'welcome_kickoff_call', { status: 'completed' }, opsRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps terminal to 409', async () => {
    const { controller } = buildController({
      updateStep: vi.fn(
        async (): Promise<UpdateStepOutcome> => ({
          ok: false,
          reason: 'terminal',
          status: 'canceled',
        }),
      ),
    });
    await expect(
      controller.updateStep('onb_1', 'welcome_kickoff_call', { status: 'completed' }, opsRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('OnboardingController.getMine', () => {
  it('resolves the household from the token scope', async () => {
    const { controller, service } = buildController();
    const result = await controller.getMine(householdRequest('hh_77'));
    expect(result.householdId).toBe('hh_77');
    expect(result.onboarding).not.toBeNull();
    expect(service.getOnboardingForHousehold).toHaveBeenCalledWith('hh_77');
  });

  it('returns a null onboarding when the household has none', async () => {
    const { controller } = buildController({
      getOnboardingForHousehold: vi.fn(async () => null),
    });
    const result = await controller.getMine(householdRequest('hh_77'));
    expect(result.onboarding).toBeNull();
  });

  it('rejects a non-household (global) actor with 400', async () => {
    const { controller } = buildController();
    await expect(controller.getMine(opsRequest())).rejects.toBeInstanceOf(BadRequestException);
  });
});
