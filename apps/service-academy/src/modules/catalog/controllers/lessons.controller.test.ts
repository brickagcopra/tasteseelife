import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { AcademyLessonRecord } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import {
  LessonsService,
  type CreateLessonOutcome,
  type DeleteLessonOutcome,
  type ListLessonsOutcome,
  type UpdateLessonOutcome,
} from '../services/lessons.service';
import { LessonsController } from './lessons.controller';

const TS = '2026-06-01T00:00:00.000Z';

function record(overrides: Partial<AcademyLessonRecord> = {}): AcademyLessonRecord {
  return {
    id: 'lesson_1',
    moduleId: 'module_1',
    title: 'Knife skills',
    kind: 'video',
    contentKey: null,
    bodyMarkdown: null,
    sortPosition: 0,
    durationMinutes: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

interface FakeService {
  listLessons: ReturnType<typeof vi.fn>;
  createLesson: ReturnType<typeof vi.fn>;
  updateLesson: ReturnType<typeof vi.fn>;
  deleteLesson: ReturnType<typeof vi.fn>;
}

function build(overrides: Partial<FakeService> = {}): {
  controller: LessonsController;
  service: FakeService;
} {
  const service: FakeService = {
    listLessons: vi.fn(
      async (): Promise<ListLessonsOutcome> => ({ ok: true, lessons: [record()] }),
    ),
    createLesson: vi.fn(async (): Promise<CreateLessonOutcome> => ({ ok: true, lesson: record() })),
    updateLesson: vi.fn(
      async (): Promise<UpdateLessonOutcome> => ({
        ok: true,
        lesson: record({ title: 'Renamed' }),
      }),
    ),
    deleteLesson: vi.fn(async (): Promise<DeleteLessonOutcome> => ({ ok: true })),
    ...overrides,
  };
  const controller = new LessonsController(service as unknown as LessonsService);
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

describe('LessonsController.list', () => {
  it('returns the lessons list', async () => {
    const { controller } = build();
    expect((await controller.list('module_1')).lessons).toHaveLength(1);
  });

  it('404s when the module is missing', async () => {
    const { controller } = build({
      listLessons: vi.fn(
        async (): Promise<ListLessonsOutcome> => ({ ok: false, reason: 'module_not_found' }),
      ),
    });
    await expect(controller.list('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('LessonsController.create', () => {
  const body = { title: 'A', kind: 'video' as const };

  it('creates and attributes the actor', async () => {
    const { controller, service } = build();
    await controller.create('module_1', body, adminRequest('u9'));
    expect(service.createLesson).toHaveBeenCalledWith(
      expect.objectContaining({ moduleId: 'module_1', actorUserId: 'u9' }),
    );
  });

  it('401s without a context', async () => {
    const { controller } = build();
    await expect(
      controller.create('module_1', body, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('404s when the module is missing', async () => {
    const { controller } = build({
      createLesson: vi.fn(
        async (): Promise<CreateLessonOutcome> => ({ ok: false, reason: 'module_not_found' }),
      ),
    });
    await expect(controller.create('nope', body, adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('LessonsController.update', () => {
  it('updates a lesson', async () => {
    const { controller } = build();
    expect(
      (await controller.update('lesson_1', { title: 'Renamed' }, adminRequest())).lesson.title,
    ).toBe('Renamed');
  });

  it('404s on not_found', async () => {
    const { controller } = build({
      updateLesson: vi.fn(
        async (): Promise<UpdateLessonOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.update('nope', { title: 'x' }, adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('LessonsController.remove', () => {
  it('resolves void on success (204)', async () => {
    const { controller } = build();
    await expect(controller.remove('lesson_1', adminRequest())).resolves.toBeUndefined();
  });

  it('404s on not_found', async () => {
    const { controller } = build({
      deleteLesson: vi.fn(
        async (): Promise<DeleteLessonOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.remove('nope', adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
