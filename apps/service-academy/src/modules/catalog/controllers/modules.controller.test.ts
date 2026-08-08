import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { AcademyCourseModuleRecord } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import {
  ModulesService,
  type CreateModuleOutcome,
  type DeleteModuleOutcome,
  type ListModulesOutcome,
  type UpdateModuleOutcome,
} from '../services/modules.service';
import { ModulesController } from './modules.controller';

const TS = '2026-06-01T00:00:00.000Z';

function record(overrides: Partial<AcademyCourseModuleRecord> = {}): AcademyCourseModuleRecord {
  return {
    id: 'module_1',
    courseId: 'course_1',
    title: 'Foundations',
    description: null,
    sortPosition: 0,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

interface FakeService {
  listModules: ReturnType<typeof vi.fn>;
  createModule: ReturnType<typeof vi.fn>;
  updateModule: ReturnType<typeof vi.fn>;
  deleteModule: ReturnType<typeof vi.fn>;
}

function build(overrides: Partial<FakeService> = {}): {
  controller: ModulesController;
  service: FakeService;
} {
  const service: FakeService = {
    listModules: vi.fn(
      async (): Promise<ListModulesOutcome> => ({ ok: true, modules: [record()] }),
    ),
    createModule: vi.fn(async (): Promise<CreateModuleOutcome> => ({ ok: true, module: record() })),
    updateModule: vi.fn(
      async (): Promise<UpdateModuleOutcome> => ({
        ok: true,
        module: record({ title: 'Renamed' }),
      }),
    ),
    deleteModule: vi.fn(
      async (): Promise<DeleteModuleOutcome> => ({
        ok: true,
        deletedModuleId: 'module_1',
        deletedLessonCount: 3,
      }),
    ),
    ...overrides,
  };
  const controller = new ModulesController(service as unknown as ModulesService);
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

describe('ModulesController.list', () => {
  it('returns the modules list', async () => {
    const { controller } = build();
    expect((await controller.list('course_1')).modules).toHaveLength(1);
  });

  it('404s when the course is missing', async () => {
    const { controller } = build({
      listModules: vi.fn(
        async (): Promise<ListModulesOutcome> => ({ ok: false, reason: 'course_not_found' }),
      ),
    });
    await expect(controller.list('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ModulesController.create', () => {
  it('creates and attributes the actor', async () => {
    const { controller, service } = build();
    await controller.create('course_1', { title: 'A' }, adminRequest('u9'));
    expect(service.createModule).toHaveBeenCalledWith(
      expect.objectContaining({ courseId: 'course_1', actorUserId: 'u9' }),
    );
  });

  it('401s without a context', async () => {
    const { controller } = build();
    await expect(
      controller.create('course_1', { title: 'A' }, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('404s when the course is missing', async () => {
    const { controller } = build({
      createModule: vi.fn(
        async (): Promise<CreateModuleOutcome> => ({ ok: false, reason: 'course_not_found' }),
      ),
    });
    await expect(controller.create('nope', { title: 'A' }, adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ModulesController.update', () => {
  it('updates a module', async () => {
    const { controller } = build();
    expect(
      (await controller.update('module_1', { title: 'Renamed' }, adminRequest())).module.title,
    ).toBe('Renamed');
  });

  it('404s on not_found', async () => {
    const { controller } = build({
      updateModule: vi.fn(
        async (): Promise<UpdateModuleOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.update('nope', { title: 'x' }, adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ModulesController.remove', () => {
  it('returns the cascade count', async () => {
    const { controller } = build();
    const response = await controller.remove('module_1', adminRequest());
    expect(response).toEqual({ deletedModuleId: 'module_1', deletedLessonCount: 3 });
  });

  it('404s on not_found', async () => {
    const { controller } = build({
      deleteModule: vi.fn(
        async (): Promise<DeleteModuleOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.remove('nope', adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
