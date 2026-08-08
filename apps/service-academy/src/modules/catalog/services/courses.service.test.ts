import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { FakeAcademyPrisma, FakeTable } from './__fixtures__/fake-prisma';
import { CoursesService, type CreateCourseInput } from './courses.service';

/**
 * Unit tests for `CoursesService` (TS-251). The in-memory `FakeAcademyPrisma`
 * pins the service's branching logic; FK / cascade / transactional behaviour is
 * covered by the Testcontainers integration test (TS-251-followup).
 */

function build(): { service: CoursesService; fake: FakeAcademyPrisma } {
  const fake = new FakeAcademyPrisma();
  const service = new CoursesService(fake as unknown as PrismaService);
  return { service, fake };
}

function createInput(overrides: Partial<CreateCourseInput> = {}): CreateCourseInput {
  return {
    slug: 'knife-skills-101',
    title: 'Knife Skills 101',
    summary: 'Master the fundamentals.',
    kind: 'self_paced',
    track: 'general',
    status: 'draft',
    actorUserId: 'user_admin',
    ...overrides,
  };
}

describe('CoursesService.createCourse', () => {
  it('persists a new course and returns the record', async () => {
    const { service, fake } = build();
    const outcome = await service.createCourse(createInput());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.course.slug).toBe('knife-skills-101');
    expect(outcome.course.status).toBe('draft');
    expect(outcome.course.deletedAt).toBeNull();
    expect(fake.academyCourse.rows).toHaveLength(1);
  });

  it('rejects a slug already in use (incl. by a soft-deleted course)', async () => {
    const { service, fake } = build();
    fake.academyCourse.seed({
      id: 'course_existing',
      slug: 'knife-skills-101',
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    } as never);

    const outcome = await service.createCourse(createInput());
    expect(outcome).toEqual({ ok: false, reason: 'slug_conflict' });
  });
});

describe('CoursesService.listCourses', () => {
  async function seedThree(service: CoursesService): Promise<void> {
    await service.createCourse(createInput({ slug: 'a', status: 'draft', track: 'general' }));
    await service.createCourse(
      createInput({ slug: 'b', status: 'published', track: 'dementia_sensitive' }),
    );
    await service.createCourse(createInput({ slug: 'c', status: 'published', track: 'general' }));
  }

  it('returns live courses and filters by status + track', async () => {
    const { service } = build();
    await seedThree(service);

    const all = await service.listCourses({ limit: 50 });
    expect(all).toHaveLength(3);

    const published = await service.listCourses({ status: 'published', limit: 50 });
    expect(published.map((c) => c.slug).sort()).toEqual(['b', 'c']);

    const general = await service.listCourses({ track: 'general', limit: 50 });
    expect(general.map((c) => c.slug).sort()).toEqual(['a', 'c']);
  });

  it('excludes soft-deleted courses unless includeDeleted is set', async () => {
    const { service, fake } = build();
    await service.createCourse(createInput({ slug: 'live' }));
    fake.academyCourse.seed({
      id: 'course_dead',
      slug: 'dead',
      status: 'archived',
      track: 'general',
      kind: 'self_paced',
      title: 'x',
      summary: 'y',
      description: null,
      level: null,
      estimatedMinutes: null,
      heroImageKey: null,
      passingScorePercent: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    } as never);

    expect(await service.listCourses({ limit: 50 })).toHaveLength(1);
    expect(await service.listCourses({ includeDeleted: true, limit: 50 })).toHaveLength(2);
  });

  it('honours the limit', async () => {
    const { service } = build();
    await seedThree(service);
    expect(await service.listCourses({ limit: 2 })).toHaveLength(2);
  });
});

describe('CoursesService.getCourseDetail', () => {
  it('assembles the ordered module → lesson tree', async () => {
    const { service, fake } = build();
    const created = await service.createCourse(createInput());
    if (!created.ok) throw new Error('precondition');
    const courseId = created.course.id;

    fake.academyCourseModule.seed({
      id: 'module_2',
      courseId,
      title: 'Second',
      description: null,
      sortPosition: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    fake.academyCourseModule.seed({
      id: 'module_1',
      courseId,
      title: 'First',
      description: null,
      sortPosition: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    fake.academyLesson.seed({
      id: 'lesson_1',
      moduleId: 'module_1',
      title: 'Intro',
      kind: 'video',
      contentKey: null,
      bodyMarkdown: null,
      sortPosition: 0,
      durationMinutes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const outcome = await service.getCourseDetail(courseId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.course.modules.map((m) => m.title)).toEqual(['First', 'Second']);
    expect(outcome.course.modules[0]?.lessons).toHaveLength(1);
    expect(outcome.course.modules[1]?.lessons).toHaveLength(0);
  });

  it('returns not_found for a missing or soft-deleted course', async () => {
    const { service } = build();
    expect(await service.getCourseDetail('nope')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('CoursesService.updateCourse', () => {
  it('applies a status transition and field edits', async () => {
    const { service } = build();
    const created = await service.createCourse(createInput());
    if (!created.ok) throw new Error('precondition');

    const outcome = await service.updateCourse({
      courseId: created.course.id,
      title: 'Renamed',
      status: 'published',
      actorUserId: 'user_admin',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.course.title).toBe('Renamed');
    expect(outcome.course.status).toBe('published');
  });

  it('returns not_found for an unknown course', async () => {
    const { service } = build();
    expect(await service.updateCourse({ courseId: 'nope', title: 'x', actorUserId: 'u' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('rejects a slug edit that collides with another course', async () => {
    const { service } = build();
    const a = await service.createCourse(createInput({ slug: 'a' }));
    await service.createCourse(createInput({ slug: 'b' }));
    if (!a.ok) throw new Error('precondition');

    const outcome = await service.updateCourse({
      courseId: a.course.id,
      slug: 'b',
      actorUserId: 'u',
    });
    expect(outcome).toEqual({ ok: false, reason: 'slug_conflict' });
  });

  it('treats a same-slug edit as a no-op (no false conflict)', async () => {
    const { service } = build();
    const a = await service.createCourse(createInput({ slug: 'a' }));
    if (!a.ok) throw new Error('precondition');

    const outcome = await service.updateCourse({
      courseId: a.course.id,
      slug: 'a',
      actorUserId: 'u',
    });
    expect(outcome.ok).toBe(true);
  });
});

describe('CoursesService.softDeleteCourse', () => {
  it('soft-deletes a course with no cohorts', async () => {
    const { service } = build();
    const created = await service.createCourse(createInput());
    if (!created.ok) throw new Error('precondition');

    const outcome = await service.softDeleteCourse(created.course.id, 'user_admin');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.course.deletedAt).not.toBeNull();
  });

  it('returns not_found for an unknown course', async () => {
    const { service } = build();
    expect(await service.softDeleteCourse('nope', 'u')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses to delete a course that still has a live cohort', async () => {
    const { service, fake } = build();
    const created = await service.createCourse(createInput());
    if (!created.ok) throw new Error('precondition');
    fake.academyCohort.seed({
      id: 'cohort_1',
      courseId: created.course.id,
      deletedAt: null,
    } as never);

    expect(await service.softDeleteCourse(created.course.id, 'u')).toEqual({
      ok: false,
      reason: 'has_cohorts',
    });
  });
});

describe('FakeTable sanity', () => {
  it('generates incrementing ids', async () => {
    const t = new FakeTable('x');
    const a = await t.create({ data: {} });
    const b = await t.create({ data: {} });
    expect((a as { id: string }).id).toBe('x_1');
    expect((b as { id: string }).id).toBe('x_2');
  });
});
