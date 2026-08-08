import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { FakeAcademyPrisma } from './__fixtures__/fake-prisma';
import { LessonsService } from './lessons.service';

/** Unit tests for `LessonsService` (TS-251). */

function build(): { service: LessonsService; fake: FakeAcademyPrisma } {
  const fake = new FakeAcademyPrisma();
  const service = new LessonsService(fake as unknown as PrismaService);
  return { service, fake };
}

function seedModule(fake: FakeAcademyPrisma, id = 'module_1'): string {
  fake.academyCourseModule.seed({ id, courseId: 'course_1' } as never);
  return id;
}

describe('LessonsService.createLesson', () => {
  it('appends with the next sort position', async () => {
    const { service, fake } = build();
    const moduleId = seedModule(fake);
    const a = await service.createLesson({ moduleId, title: 'A', kind: 'video', actorUserId: 'u' });
    const b = await service.createLesson({
      moduleId,
      title: 'B',
      kind: 'reading',
      actorUserId: 'u',
    });
    expect(a.ok && a.lesson.sortPosition).toBe(0);
    expect(b.ok && b.lesson.sortPosition).toBe(1);
  });

  it('persists content fields', async () => {
    const { service, fake } = build();
    const moduleId = seedModule(fake);
    const outcome = await service.createLesson({
      moduleId,
      title: 'Reading',
      kind: 'reading',
      bodyMarkdown: '# Mise en place',
      durationMinutes: 8,
      actorUserId: 'u',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.lesson.bodyMarkdown).toBe('# Mise en place');
    expect(outcome.lesson.durationMinutes).toBe(8);
    expect(outcome.lesson.contentKey).toBeNull();
  });

  it('returns module_not_found when the module is missing', async () => {
    const { service } = build();
    expect(
      await service.createLesson({ moduleId: 'nope', title: 'A', kind: 'video', actorUserId: 'u' }),
    ).toEqual({ ok: false, reason: 'module_not_found' });
  });
});

describe('LessonsService.listLessons', () => {
  it('returns the module lessons ordered by sort position', async () => {
    const { service, fake } = build();
    const moduleId = seedModule(fake);
    await service.createLesson({
      moduleId,
      title: 'A',
      kind: 'video',
      sortPosition: 2,
      actorUserId: 'u',
    });
    await service.createLesson({
      moduleId,
      title: 'B',
      kind: 'video',
      sortPosition: 0,
      actorUserId: 'u',
    });

    const outcome = await service.listLessons(moduleId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.lessons.map((l) => l.title)).toEqual(['B', 'A']);
  });

  it('returns module_not_found for an unknown module', async () => {
    const { service } = build();
    expect(await service.listLessons('nope')).toEqual({ ok: false, reason: 'module_not_found' });
  });
});

describe('LessonsService.updateLesson', () => {
  it('applies a partial update and clears nullable fields', async () => {
    const { service, fake } = build();
    const moduleId = seedModule(fake);
    const created = await service.createLesson({
      moduleId,
      title: 'A',
      kind: 'video',
      contentKey: 'academy/a.mp4',
      actorUserId: 'u',
    });
    if (!created.ok) throw new Error('precondition');

    const outcome = await service.updateLesson({
      lessonId: created.lesson.id,
      title: 'Renamed',
      contentKey: null,
      actorUserId: 'u',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.lesson.title).toBe('Renamed');
    expect(outcome.lesson.contentKey).toBeNull();
  });

  it('returns not_found for an unknown lesson', async () => {
    const { service } = build();
    expect(await service.updateLesson({ lessonId: 'nope', title: 'x', actorUserId: 'u' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('LessonsService.deleteLesson', () => {
  it('deletes a lesson', async () => {
    const { service, fake } = build();
    const moduleId = seedModule(fake);
    const created = await service.createLesson({
      moduleId,
      title: 'A',
      kind: 'video',
      actorUserId: 'u',
    });
    if (!created.ok) throw new Error('precondition');

    expect(await service.deleteLesson(created.lesson.id, 'u')).toEqual({ ok: true });
    expect(fake.academyLesson.rows).toHaveLength(0);
  });

  it('returns not_found for an unknown lesson', async () => {
    const { service } = build();
    expect(await service.deleteLesson('nope', 'u')).toEqual({ ok: false, reason: 'not_found' });
  });
});
