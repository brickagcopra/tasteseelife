import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type {
  AcademyCourseDetail,
  AcademyCourseRecord,
  ListAcademyCoursesQuery,
} from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import {
  CoursesService,
  type CreateCourseOutcome,
  type DeleteCourseOutcome,
  type GetCourseOutcome,
  type UpdateCourseOutcome,
} from '../services/courses.service';
import { CoursesController } from './courses.controller';

const TS = '2026-06-01T00:00:00.000Z';

function record(overrides: Partial<AcademyCourseRecord> = {}): AcademyCourseRecord {
  return {
    id: 'course_1',
    slug: 'knife-skills-101',
    title: 'Knife Skills 101',
    summary: 'Master the fundamentals.',
    description: null,
    kind: 'self_paced',
    track: 'general',
    status: 'draft',
    level: null,
    estimatedMinutes: null,
    heroImageKey: null,
    passingScorePercent: null,
    createdAt: TS,
    updatedAt: TS,
    deletedAt: null,
    ...overrides,
  };
}

interface FakeService {
  listCourses: ReturnType<typeof vi.fn>;
  createCourse: ReturnType<typeof vi.fn>;
  getCourseDetail: ReturnType<typeof vi.fn>;
  updateCourse: ReturnType<typeof vi.fn>;
  softDeleteCourse: ReturnType<typeof vi.fn>;
}

function build(overrides: Partial<FakeService> = {}): {
  controller: CoursesController;
  service: FakeService;
} {
  const detail: AcademyCourseDetail = { ...record(), modules: [] };
  const service: FakeService = {
    listCourses: vi.fn(async (): Promise<readonly AcademyCourseRecord[]> => [record()]),
    createCourse: vi.fn(async (): Promise<CreateCourseOutcome> => ({ ok: true, course: record() })),
    getCourseDetail: vi.fn(async (): Promise<GetCourseOutcome> => ({ ok: true, course: detail })),
    updateCourse: vi.fn(async (): Promise<UpdateCourseOutcome> => ({ ok: true, course: record() })),
    softDeleteCourse: vi.fn(
      async (): Promise<DeleteCourseOutcome> => ({ ok: true, course: record({ deletedAt: TS }) }),
    ),
    ...overrides,
  };
  const controller = new CoursesController(service as unknown as CoursesService);
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

const listQuery: ListAcademyCoursesQuery = { limit: 50 };

describe('CoursesController.list', () => {
  it('returns the contract-shaped list', async () => {
    const { controller } = build();
    const response = await controller.list(listQuery);
    expect(response.courses).toHaveLength(1);
  });

  it('forwards filters to the service', async () => {
    const { controller, service } = build();
    await controller.list({
      status: 'published',
      track: 'general',
      kind: 'self_paced',
      includeDeleted: true,
      limit: 10,
    });
    expect(service.listCourses).toHaveBeenCalledWith({
      status: 'published',
      track: 'general',
      kind: 'self_paced',
      includeDeleted: true,
      limit: 10,
    });
  });
});

describe('CoursesController.create', () => {
  const body = {
    slug: 'soups',
    title: 'Soups',
    summary: 'Comfort.',
    kind: 'self_paced' as const,
    track: 'general' as const,
    status: 'draft' as const,
  };

  it('creates and attributes the actor from the token', async () => {
    const { controller, service } = build();
    const response = await controller.create(body, adminRequest('user_x'));
    expect(response.course.id).toBe('course_1');
    expect(service.createCourse).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'user_x' }),
    );
  });

  it('401s without a request context', async () => {
    const { controller } = build();
    await expect(
      controller.create(body, { requestContext: undefined } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('409s on a slug conflict', async () => {
    const { controller } = build({
      createCourse: vi.fn(
        async (): Promise<CreateCourseOutcome> => ({ ok: false, reason: 'slug_conflict' }),
      ),
    });
    await expect(controller.create(body, adminRequest())).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CoursesController.detail', () => {
  it('returns the tree', async () => {
    const { controller } = build();
    const response = await controller.detail('course_1');
    expect(response.course.modules).toEqual([]);
  });

  it('404s when missing', async () => {
    const { controller } = build({
      getCourseDetail: vi.fn(
        async (): Promise<GetCourseOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.detail('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CoursesController.update', () => {
  it('updates and returns the record', async () => {
    const { controller } = build();
    const response = await controller.update('course_1', { status: 'published' }, adminRequest());
    expect(response.course.id).toBe('course_1');
  });

  it('404s on not_found', async () => {
    const { controller } = build({
      updateCourse: vi.fn(
        async (): Promise<UpdateCourseOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.update('nope', { title: 'x' }, adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('409s on slug_conflict and invalid_transition', async () => {
    const conflictSvc = build({
      updateCourse: vi.fn(
        async (): Promise<UpdateCourseOutcome> => ({ ok: false, reason: 'slug_conflict' }),
      ),
    });
    await expect(
      conflictSvc.controller.update('course_1', { slug: 'taken' }, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);

    const transitionSvc = build({
      updateCourse: vi.fn(
        async (): Promise<UpdateCourseOutcome> => ({
          ok: false,
          reason: 'invalid_transition',
          from: 'draft',
          to: 'archived',
        }),
      ),
    });
    await expect(
      transitionSvc.controller.update('course_1', { status: 'archived' }, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CoursesController.remove', () => {
  it('returns the soft-deleted record', async () => {
    const { controller } = build();
    const response = await controller.remove('course_1', adminRequest());
    expect(response.course.deletedAt).toBe(TS);
  });

  it('404s on not_found', async () => {
    const { controller } = build({
      softDeleteCourse: vi.fn(
        async (): Promise<DeleteCourseOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.remove('nope', adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('409s when the course still has cohorts', async () => {
    const { controller } = build({
      softDeleteCourse: vi.fn(
        async (): Promise<DeleteCourseOutcome> => ({ ok: false, reason: 'has_cohorts' }),
      ),
    });
    await expect(controller.remove('course_1', adminRequest())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
