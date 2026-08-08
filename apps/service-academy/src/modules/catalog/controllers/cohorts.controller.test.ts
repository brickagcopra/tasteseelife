import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { AcademyCohortRecord, ListAcademyCohortsQuery } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import {
  CohortsService,
  type CreateCohortOutcome,
  type DeleteCohortOutcome,
  type ListCohortsOutcome,
  type UpdateCohortOutcome,
} from '../services/cohorts.service';
import { CohortsController } from './cohorts.controller';

const START = '2026-06-01T18:00:00.000Z';
const END = '2026-06-30T20:00:00.000Z';

function record(overrides: Partial<AcademyCohortRecord> = {}): AcademyCohortRecord {
  return {
    id: 'cohort_1',
    courseId: 'course_1',
    name: 'Spring 2026',
    status: 'scheduled',
    startsAt: START,
    endsAt: END,
    capacity: 12,
    instructorUserId: null,
    createdAt: START,
    updatedAt: START,
    deletedAt: null,
    ...overrides,
  };
}

interface FakeService {
  listCohorts: ReturnType<typeof vi.fn>;
  createCohort: ReturnType<typeof vi.fn>;
  updateCohort: ReturnType<typeof vi.fn>;
  softDeleteCohort: ReturnType<typeof vi.fn>;
}

function build(overrides: Partial<FakeService> = {}): {
  controller: CohortsController;
  service: FakeService;
} {
  const service: FakeService = {
    listCohorts: vi.fn(
      async (): Promise<ListCohortsOutcome> => ({ ok: true, cohorts: [record()] }),
    ),
    createCohort: vi.fn(async (): Promise<CreateCohortOutcome> => ({ ok: true, cohort: record() })),
    updateCohort: vi.fn(
      async (): Promise<UpdateCohortOutcome> => ({ ok: true, cohort: record({ status: 'open' }) }),
    ),
    softDeleteCohort: vi.fn(
      async (): Promise<DeleteCohortOutcome> => ({
        ok: true,
        cohort: record({ deletedAt: START }),
      }),
    ),
    ...overrides,
  };
  const controller = new CohortsController(service as unknown as CohortsService);
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

const listQuery: ListAcademyCohortsQuery = { limit: 50 };
const createBody = { name: 'Spring 2026', startsAt: START, status: 'scheduled' as const };

describe('CohortsController.list', () => {
  it('returns the cohorts list', async () => {
    const { controller } = build();
    expect((await controller.list('course_1', listQuery)).cohorts).toHaveLength(1);
  });

  it('404s when the course is missing', async () => {
    const { controller } = build({
      listCohorts: vi.fn(
        async (): Promise<ListCohortsOutcome> => ({ ok: false, reason: 'course_not_found' }),
      ),
    });
    await expect(controller.list('nope', listQuery)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CohortsController.create', () => {
  it('creates and attributes the actor', async () => {
    const { controller, service } = build();
    await controller.create('course_1', createBody, adminRequest('u9'));
    expect(service.createCohort).toHaveBeenCalledWith(
      expect.objectContaining({ courseId: 'course_1', actorUserId: 'u9' }),
    );
  });

  it('401s without a context', async () => {
    const { controller } = build();
    await expect(
      controller.create('course_1', createBody, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('404s when the course is missing', async () => {
    const { controller } = build({
      createCohort: vi.fn(
        async (): Promise<CreateCohortOutcome> => ({ ok: false, reason: 'course_not_found' }),
      ),
    });
    await expect(controller.create('nope', createBody, adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('CohortsController.update', () => {
  it('updates a cohort', async () => {
    const { controller } = build();
    expect(
      (await controller.update('cohort_1', { status: 'open' }, adminRequest())).cohort.status,
    ).toBe('open');
  });

  it('404s on not_found', async () => {
    const { controller } = build({
      updateCohort: vi.fn(
        async (): Promise<UpdateCohortOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.update('nope', { name: 'x' }, adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('409s on terminal / invalid_transition / invalid_time_range', async () => {
    const terminal = build({
      updateCohort: vi.fn(
        async (): Promise<UpdateCohortOutcome> => ({
          ok: false,
          reason: 'terminal',
          status: 'completed',
        }),
      ),
    });
    await expect(
      terminal.controller.update('c', { name: 'x' }, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);

    const transition = build({
      updateCohort: vi.fn(
        async (): Promise<UpdateCohortOutcome> => ({
          ok: false,
          reason: 'invalid_transition',
          from: 'scheduled',
          to: 'completed',
        }),
      ),
    });
    await expect(
      transition.controller.update('c', { status: 'completed' }, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);

    const timeRange = build({
      updateCohort: vi.fn(
        async (): Promise<UpdateCohortOutcome> => ({ ok: false, reason: 'invalid_time_range' }),
      ),
    });
    await expect(
      timeRange.controller.update('c', { startsAt: END, endsAt: START }, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CohortsController.remove', () => {
  it('returns the soft-deleted cohort', async () => {
    const { controller } = build();
    expect((await controller.remove('cohort_1', adminRequest())).cohort.deletedAt).toBe(START);
  });

  it('404s on not_found', async () => {
    const { controller } = build({
      softDeleteCohort: vi.fn(
        async (): Promise<DeleteCohortOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.remove('nope', adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
