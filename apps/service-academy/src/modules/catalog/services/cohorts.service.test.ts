import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { FakeAcademyPrisma } from './__fixtures__/fake-prisma';
import { CohortsService, type CreateCohortInput } from './cohorts.service';

/** Unit tests for `CohortsService` (TS-251). */

const START = '2026-06-01T18:00:00.000Z';
const END = '2026-06-30T20:00:00.000Z';

function build(): { service: CohortsService; fake: FakeAcademyPrisma } {
  const fake = new FakeAcademyPrisma();
  const service = new CohortsService(fake as unknown as PrismaService);
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

function createInput(
  courseId: string,
  overrides: Partial<CreateCohortInput> = {},
): CreateCohortInput {
  return {
    courseId,
    name: 'Spring 2026',
    startsAt: START,
    status: 'scheduled',
    actorUserId: 'u',
    ...overrides,
  };
}

describe('CohortsService.createCohort', () => {
  it('schedules a cohort under a live course', async () => {
    const { service, fake } = build();
    const courseId = seedCourse(fake);
    const outcome = await service.createCohort(
      createInput(courseId, { endsAt: END, capacity: 12 }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cohort.name).toBe('Spring 2026');
    expect(outcome.cohort.endsAt).toBe(new Date(END).toISOString());
    expect(outcome.cohort.capacity).toBe(12);
    expect(outcome.cohort.deletedAt).toBeNull();
  });

  it('returns course_not_found when the course is missing or soft-deleted', async () => {
    const { service, fake } = build();
    expect(await service.createCohort(createInput('nope'))).toEqual({
      ok: false,
      reason: 'course_not_found',
    });
    seedCourse(fake, 'dead', new Date());
    expect(await service.createCohort(createInput('dead'))).toEqual({
      ok: false,
      reason: 'course_not_found',
    });
  });
});

describe('CohortsService.listCohorts', () => {
  it('orders by startsAt and filters by status', async () => {
    const { service, fake } = build();
    const courseId = seedCourse(fake);
    await service.createCohort(createInput(courseId, { name: 'late', startsAt: END }));
    await service.createCohort(
      createInput(courseId, { name: 'early', startsAt: START, status: 'open' }),
    );

    const all = await service.listCohorts({ courseId, limit: 50 });
    expect(all.ok && all.cohorts.map((c) => c.name)).toEqual(['early', 'late']);

    const open = await service.listCohorts({ courseId, status: 'open', limit: 50 });
    expect(open.ok && open.cohorts.map((c) => c.name)).toEqual(['early']);
  });

  it('excludes soft-deleted cohorts unless includeDeleted is set', async () => {
    const { service, fake } = build();
    const courseId = seedCourse(fake);
    await service.createCohort(createInput(courseId, { name: 'live' }));
    fake.academyCohort.seed({
      id: 'cohort_dead',
      courseId,
      name: 'dead',
      status: 'canceled',
      startsAt: new Date(START),
      endsAt: null,
      capacity: null,
      instructorUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: new Date(),
    } as never);

    const live = await service.listCohorts({ courseId, limit: 50 });
    expect(live.ok && live.cohorts).toHaveLength(1);
    const withDeleted = await service.listCohorts({ courseId, includeDeleted: true, limit: 50 });
    expect(withDeleted.ok && withDeleted.cohorts).toHaveLength(2);
  });

  it('returns course_not_found for an unknown course', async () => {
    const { service } = build();
    expect(await service.listCohorts({ courseId: 'nope', limit: 50 })).toEqual({
      ok: false,
      reason: 'course_not_found',
    });
  });
});

describe('CohortsService.updateCohort', () => {
  async function seedScheduled(): Promise<{
    service: CohortsService;
    fake: FakeAcademyPrisma;
    cohortId: string;
  }> {
    const { service, fake } = build();
    const courseId = seedCourse(fake);
    const created = await service.createCohort(createInput(courseId, { endsAt: END }));
    if (!created.ok) throw new Error('precondition');
    return { service, fake, cohortId: created.cohort.id };
  }

  it('applies an allowed status transition', async () => {
    const { service, cohortId } = await seedScheduled();
    const outcome = await service.updateCohort({ cohortId, status: 'open', actorUserId: 'u' });
    expect(outcome.ok && outcome.cohort.status).toBe('open');
  });

  it('rejects a disallowed transition', async () => {
    const { service, cohortId } = await seedScheduled();
    const outcome = await service.updateCohort({ cohortId, status: 'completed', actorUserId: 'u' });
    expect(outcome).toEqual({
      ok: false,
      reason: 'invalid_transition',
      from: 'scheduled',
      to: 'completed',
    });
  });

  it('rejects edits to a terminal cohort', async () => {
    const { service, fake } = build();
    const courseId = seedCourse(fake);
    fake.academyCohort.seed({
      id: 'cohort_done',
      courseId,
      name: 'done',
      status: 'completed',
      startsAt: new Date(START),
      endsAt: new Date(END),
      capacity: null,
      instructorUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as never);

    expect(
      await service.updateCohort({ cohortId: 'cohort_done', name: 'x', actorUserId: 'u' }),
    ).toEqual({
      ok: false,
      reason: 'terminal',
      status: 'completed',
    });
  });

  it('rejects a non-monotonic merged start/end pair', async () => {
    const { service, cohortId } = await seedScheduled();
    const outcome = await service.updateCohort({
      cohortId,
      startsAt: END,
      endsAt: START,
      actorUserId: 'u',
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_time_range' });
  });

  it('clears nullable fields', async () => {
    const { service, cohortId } = await seedScheduled();
    const outcome = await service.updateCohort({
      cohortId,
      endsAt: null,
      capacity: null,
      actorUserId: 'u',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cohort.endsAt).toBeNull();
    expect(outcome.cohort.capacity).toBeNull();
  });

  it('returns not_found for an unknown cohort', async () => {
    const { service } = build();
    expect(await service.updateCohort({ cohortId: 'nope', name: 'x', actorUserId: 'u' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('CohortsService.softDeleteCohort', () => {
  it('soft-deletes a cohort', async () => {
    const { service, fake } = build();
    const courseId = seedCourse(fake);
    const created = await service.createCohort(createInput(courseId));
    if (!created.ok) throw new Error('precondition');

    const outcome = await service.softDeleteCohort(created.cohort.id, 'u');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cohort.deletedAt).not.toBeNull();
  });

  it('returns not_found for an unknown cohort', async () => {
    const { service } = build();
    expect(await service.softDeleteCohort('nope', 'u')).toEqual({ ok: false, reason: 'not_found' });
  });
});
