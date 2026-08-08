import { describe, expect, it } from 'vitest';

import {
  ACADEMY_COURSE_STATUS_TRANSITIONS,
  ACADEMY_COURSE_SUMMARY_MAX_LENGTH,
  ACADEMY_COURSES_LIST_LIMIT_DEFAULT,
  ACADEMY_COURSES_LIST_LIMIT_MAX,
  AcademyCourseDetailSchema,
  AcademyCourseRecordSchema,
  AcademyCourseResponseSchema,
  AcademyCoursesListResponseSchema,
  CreateAcademyCourseRequestSchema,
  ListAcademyCoursesQuerySchema,
  UpdateAcademyCourseRequestSchema,
  canTransitionAcademyCourse,
  type AcademyCourseStatus,
} from '../http/academy-course.schema';

const TS = '2026-06-01T18:00:00.000Z';

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'course_1',
    slug: 'knife-skills-101',
    title: 'Knife Skills 101',
    summary: 'Master the fundamentals of safe, efficient knife work.',
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

describe('AcademyCourseRecordSchema', () => {
  it('parses a complete record', () => {
    expect(AcademyCourseRecordSchema.parse(validRecord()).slug).toBe('knife-skills-101');
  });

  it('rejects an unknown field (strict)', () => {
    expect(AcademyCourseRecordSchema.safeParse(validRecord({ extra: 1 })).success).toBe(false);
  });

  it('rejects a non-kebab slug', () => {
    expect(AcademyCourseRecordSchema.safeParse(validRecord({ slug: 'Knife Skills' })).success).toBe(
      false,
    );
    expect(AcademyCourseRecordSchema.safeParse(validRecord({ slug: '-leading' })).success).toBe(
      false,
    );
    expect(
      AcademyCourseRecordSchema.safeParse(validRecord({ slug: 'double--hyphen' })).success,
    ).toBe(false);
  });

  it('rejects a summary past the cap', () => {
    expect(
      AcademyCourseRecordSchema.safeParse(
        validRecord({ summary: 'x'.repeat(ACADEMY_COURSE_SUMMARY_MAX_LENGTH + 1) }),
      ).success,
    ).toBe(false);
  });

  it('rejects a passing score above 100', () => {
    expect(
      AcademyCourseRecordSchema.safeParse(validRecord({ passingScorePercent: 101 })).success,
    ).toBe(false);
  });
});

describe('AcademyCourseDetailSchema', () => {
  it('nests an ordered module tree', () => {
    const parsed = AcademyCourseDetailSchema.parse({
      ...validRecord(),
      modules: [
        {
          id: 'module_1',
          courseId: 'course_1',
          title: 'Foundations',
          description: null,
          sortPosition: 0,
          createdAt: TS,
          updatedAt: TS,
          lessons: [],
        },
      ],
    });
    expect(parsed.modules[0]?.lessons).toEqual([]);
  });

  it('requires the modules array', () => {
    expect(AcademyCourseDetailSchema.safeParse(validRecord()).success).toBe(false);
  });
});

describe('CreateAcademyCourseRequestSchema', () => {
  it('defaults track to general and status to draft', () => {
    const parsed = CreateAcademyCourseRequestSchema.parse({
      slug: 'soups-and-stews',
      title: 'Soups & Stews',
      summary: 'Comfort cooking for cold months.',
      kind: 'cohort_based',
    });
    expect(parsed.track).toBe('general');
    expect(parsed.status).toBe('draft');
  });

  it('allows creating directly as published', () => {
    expect(
      CreateAcademyCourseRequestSchema.parse({
        slug: 's',
        title: 'T',
        summary: 'S',
        kind: 'self_paced',
        status: 'published',
      }).status,
    ).toBe('published');
  });

  it('rejects creating directly as archived', () => {
    expect(
      CreateAcademyCourseRequestSchema.safeParse({
        slug: 's',
        title: 'T',
        summary: 'S',
        kind: 'self_paced',
        status: 'archived',
      }).success,
    ).toBe(false);
  });

  it('rejects a missing required field', () => {
    expect(
      CreateAcademyCourseRequestSchema.safeParse({ slug: 's', title: 'T', kind: 'self_paced' })
        .success,
    ).toBe(false);
  });
});

describe('UpdateAcademyCourseRequestSchema', () => {
  it('accepts a single-field update', () => {
    expect(UpdateAcademyCourseRequestSchema.parse({ status: 'published' })).toEqual({
      status: 'published',
    });
  });

  it('accepts clearing nullable fields', () => {
    const parsed = UpdateAcademyCourseRequestSchema.parse({ heroImageKey: null, level: null });
    expect(parsed.heroImageKey).toBeNull();
    expect(parsed.level).toBeNull();
  });

  it('rejects an empty body', () => {
    expect(UpdateAcademyCourseRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('ListAcademyCoursesQuerySchema', () => {
  it('defaults the limit', () => {
    expect(ListAcademyCoursesQuerySchema.parse({}).limit).toBe(ACADEMY_COURSES_LIST_LIMIT_DEFAULT);
  });

  it('coerces string query params', () => {
    const parsed = ListAcademyCoursesQuerySchema.parse({ limit: '10', includeDeleted: 'true' });
    expect(parsed.limit).toBe(10);
    expect(parsed.includeDeleted).toBe(true);
  });

  it('rejects a limit past the cap', () => {
    expect(
      ListAcademyCoursesQuerySchema.safeParse({ limit: String(ACADEMY_COURSES_LIST_LIMIT_MAX + 1) })
        .success,
    ).toBe(false);
  });
});

describe('canTransitionAcademyCourse', () => {
  it('allows every cross-status move (all three are reversible admin states)', () => {
    const all: AcademyCourseStatus[] = ['draft', 'published', 'archived'];
    for (const from of all) {
      for (const to of all) {
        if (from === to) continue;
        expect(canTransitionAcademyCourse(from, to), `${from}->${to}`).toBe(true);
      }
    }
  });

  it('the transition table omits same-status self-loops', () => {
    for (const status of Object.keys(ACADEMY_COURSE_STATUS_TRANSITIONS) as AcademyCourseStatus[]) {
      expect(ACADEMY_COURSE_STATUS_TRANSITIONS[status]).not.toContain(status);
    }
  });
});

describe('course response envelopes', () => {
  it('AcademyCourseResponseSchema wraps a course', () => {
    expect(AcademyCourseResponseSchema.parse({ course: validRecord() }).course.id).toBe('course_1');
  });

  it('AcademyCoursesListResponseSchema wraps an array', () => {
    expect(
      AcademyCoursesListResponseSchema.parse({ courses: [validRecord()] }).courses,
    ).toHaveLength(1);
  });
});
