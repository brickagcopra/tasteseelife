import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { FakeAcademyPrisma } from './__fixtures__/fake-prisma';
import { ModulesService } from './modules.service';

/** Unit tests for `ModulesService` (TS-251). */

function build(): { service: ModulesService; fake: FakeAcademyPrisma } {
  const fake = new FakeAcademyPrisma();
  const service = new ModulesService(fake as unknown as PrismaService);
  return { service, fake };
}

function seedCourse(
  fake: FakeAcademyPrisma,
  id = 'course_1',
  deletedAt: Date | null = null,
): string {
  fake.academyCourse.seed({ id, slug: id, deletedAt } as never);
  return id;
}

describe('ModulesService.createModule', () => {
  it('appends with the next sort position when none supplied', async () => {
    const { service, fake } = build();
    const courseId = seedCourse(fake);

    const first = await service.createModule({ courseId, title: 'A', actorUserId: 'u' });
    const second = await service.createModule({ courseId, title: 'B', actorUserId: 'u' });

    expect(first.ok && first.module.sortPosition).toBe(0);
    expect(second.ok && second.module.sortPosition).toBe(1);
  });

  it('honours an explicit sort position', async () => {
    const { service, fake } = build();
    const courseId = seedCourse(fake);
    const outcome = await service.createModule({
      courseId,
      title: 'A',
      sortPosition: 5,
      actorUserId: 'u',
    });
    expect(outcome.ok && outcome.module.sortPosition).toBe(5);
  });

  it('returns course_not_found when the course is missing or soft-deleted', async () => {
    const { service, fake } = build();
    expect(await service.createModule({ courseId: 'nope', title: 'A', actorUserId: 'u' })).toEqual({
      ok: false,
      reason: 'course_not_found',
    });
    seedCourse(fake, 'course_dead', new Date());
    expect(
      await service.createModule({ courseId: 'course_dead', title: 'A', actorUserId: 'u' }),
    ).toEqual({ ok: false, reason: 'course_not_found' });
  });
});

describe('ModulesService.listModules', () => {
  it('returns the course modules ordered by sort position', async () => {
    const { service, fake } = build();
    const courseId = seedCourse(fake);
    await service.createModule({ courseId, title: 'A', sortPosition: 2, actorUserId: 'u' });
    await service.createModule({ courseId, title: 'B', sortPosition: 0, actorUserId: 'u' });

    const outcome = await service.listModules(courseId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.modules.map((m) => m.title)).toEqual(['B', 'A']);
  });

  it('returns course_not_found for an unknown course', async () => {
    const { service } = build();
    expect(await service.listModules('nope')).toEqual({ ok: false, reason: 'course_not_found' });
  });
});

describe('ModulesService.updateModule', () => {
  it('applies a partial update', async () => {
    const { service, fake } = build();
    const courseId = seedCourse(fake);
    const created = await service.createModule({ courseId, title: 'A', actorUserId: 'u' });
    if (!created.ok) throw new Error('precondition');

    const outcome = await service.updateModule({
      moduleId: created.module.id,
      title: 'Renamed',
      description: 'now described',
      actorUserId: 'u',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.module.title).toBe('Renamed');
    expect(outcome.module.description).toBe('now described');
  });

  it('returns not_found for an unknown module', async () => {
    const { service } = build();
    expect(await service.updateModule({ moduleId: 'nope', title: 'x', actorUserId: 'u' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('ModulesService.deleteModule', () => {
  it('deletes the module and reports the cascaded lesson count', async () => {
    const { service, fake } = build();
    const courseId = seedCourse(fake);
    const created = await service.createModule({ courseId, title: 'A', actorUserId: 'u' });
    if (!created.ok) throw new Error('precondition');
    fake.academyLesson.seed({ id: 'l1', moduleId: created.module.id } as never);
    fake.academyLesson.seed({ id: 'l2', moduleId: created.module.id } as never);

    const outcome = await service.deleteModule(created.module.id, 'u');
    expect(outcome).toEqual({
      ok: true,
      deletedModuleId: created.module.id,
      deletedLessonCount: 2,
    });
    expect(fake.academyCourseModule.rows).toHaveLength(0);
  });

  it('returns not_found for an unknown module', async () => {
    const { service } = build();
    expect(await service.deleteModule('nope', 'u')).toEqual({ ok: false, reason: 'not_found' });
  });
});
