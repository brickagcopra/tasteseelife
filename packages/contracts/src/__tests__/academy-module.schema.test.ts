import { describe, expect, it } from 'vitest';

import {
  AcademyCourseModuleRecordSchema,
  AcademyCourseModuleWithLessonsSchema,
  AcademyModuleResponseSchema,
  AcademyModulesListResponseSchema,
  CreateAcademyModuleRequestSchema,
  DeleteAcademyModuleResponseSchema,
  UpdateAcademyModuleRequestSchema,
} from '../http/academy-module.schema';

const TS = '2026-06-01T18:00:00.000Z';

function validModule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'module_1',
    courseId: 'course_1',
    title: 'Foundations',
    description: 'Knife skills and mise en place.',
    sortPosition: 0,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function validLesson(): Record<string, unknown> {
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
  };
}

describe('AcademyCourseModuleRecordSchema', () => {
  it('parses a complete module', () => {
    expect(AcademyCourseModuleRecordSchema.parse(validModule()).title).toBe('Foundations');
  });

  it('accepts a null description', () => {
    expect(
      AcademyCourseModuleRecordSchema.parse(validModule({ description: null })).description,
    ).toBeNull();
  });

  it('rejects an unknown field (strict)', () => {
    expect(AcademyCourseModuleRecordSchema.safeParse(validModule({ extra: 1 })).success).toBe(
      false,
    );
  });
});

describe('AcademyCourseModuleWithLessonsSchema', () => {
  it('nests an ordered lesson array', () => {
    const parsed = AcademyCourseModuleWithLessonsSchema.parse({
      ...validModule(),
      lessons: [validLesson()],
    });
    expect(parsed.lessons).toHaveLength(1);
  });

  it('requires the lessons array', () => {
    expect(AcademyCourseModuleWithLessonsSchema.safeParse(validModule()).success).toBe(false);
  });
});

describe('CreateAcademyModuleRequestSchema', () => {
  it('accepts a title-only create', () => {
    expect(CreateAcademyModuleRequestSchema.parse({ title: 'Foundations' })).toEqual({
      title: 'Foundations',
    });
  });

  it('accepts an explicit sort position', () => {
    expect(
      CreateAcademyModuleRequestSchema.parse({ title: 'M', sortPosition: 3 }).sortPosition,
    ).toBe(3);
  });

  it('rejects an empty title', () => {
    expect(CreateAcademyModuleRequestSchema.safeParse({ title: '  ' }).success).toBe(false);
  });
});

describe('UpdateAcademyModuleRequestSchema', () => {
  it('accepts a single-field update', () => {
    expect(UpdateAcademyModuleRequestSchema.parse({ sortPosition: 2 })).toEqual({
      sortPosition: 2,
    });
  });

  it('accepts clearing the description with null', () => {
    expect(UpdateAcademyModuleRequestSchema.parse({ description: null }).description).toBeNull();
  });

  it('rejects an empty body', () => {
    expect(UpdateAcademyModuleRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('module response envelopes', () => {
  it('AcademyModuleResponseSchema wraps a module', () => {
    expect(AcademyModuleResponseSchema.parse({ module: validModule() }).module.id).toBe('module_1');
  });

  it('AcademyModulesListResponseSchema wraps an array', () => {
    expect(
      AcademyModulesListResponseSchema.parse({ modules: [validModule()] }).modules,
    ).toHaveLength(1);
  });

  it('DeleteAcademyModuleResponseSchema reports the cascade count', () => {
    const parsed = DeleteAcademyModuleResponseSchema.parse({
      deletedModuleId: 'module_1',
      deletedLessonCount: 4,
    });
    expect(parsed.deletedLessonCount).toBe(4);
  });

  it('DeleteAcademyModuleResponseSchema rejects a negative count', () => {
    expect(
      DeleteAcademyModuleResponseSchema.safeParse({ deletedModuleId: 'm', deletedLessonCount: -1 })
        .success,
    ).toBe(false);
  });
});
