import { describe, expect, it } from 'vitest';

import {
  ACADEMY_LESSON_BODY_MARKDOWN_MAX_LENGTH,
  ACADEMY_LESSON_TITLE_MAX_LENGTH,
  AcademyLessonKindSchema,
  AcademyLessonRecordSchema,
  AcademyLessonResponseSchema,
  AcademyLessonsListResponseSchema,
  CreateAcademyLessonRequestSchema,
  UpdateAcademyLessonRequestSchema,
} from '../http/academy-lesson.schema';

const TS = '2026-06-01T18:00:00.000Z';

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'lesson_1',
    moduleId: 'module_1',
    title: 'Knife skills',
    kind: 'video',
    contentKey: 'academy/lessons/knife-skills.mp4',
    bodyMarkdown: null,
    sortPosition: 0,
    durationMinutes: 12,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

describe('AcademyLessonKindSchema', () => {
  it('accepts the four lesson kinds', () => {
    for (const kind of ['video', 'reading', 'quiz', 'assignment']) {
      expect(AcademyLessonKindSchema.parse(kind)).toBe(kind);
    }
  });

  it('rejects an unknown kind', () => {
    expect(AcademyLessonKindSchema.safeParse('webinar').success).toBe(false);
  });
});

describe('AcademyLessonRecordSchema', () => {
  it('parses a complete record', () => {
    expect(AcademyLessonRecordSchema.parse(validRecord())).toMatchObject({
      id: 'lesson_1',
      kind: 'video',
      sortPosition: 0,
    });
  });

  it('accepts a reading lesson with body markdown and no content key', () => {
    const parsed = AcademyLessonRecordSchema.parse(
      validRecord({
        kind: 'reading',
        contentKey: null,
        bodyMarkdown: '# Mise en place',
        durationMinutes: null,
      }),
    );
    expect(parsed.bodyMarkdown).toBe('# Mise en place');
    expect(parsed.contentKey).toBeNull();
  });

  it('rejects an unknown field (strict)', () => {
    expect(AcademyLessonRecordSchema.safeParse(validRecord({ extra: true })).success).toBe(false);
  });

  it('rejects a negative sort position', () => {
    expect(AcademyLessonRecordSchema.safeParse(validRecord({ sortPosition: -1 })).success).toBe(
      false,
    );
  });
});

describe('CreateAcademyLessonRequestSchema', () => {
  it('accepts a minimal create (title + kind only)', () => {
    const parsed = CreateAcademyLessonRequestSchema.parse({ title: 'Intro', kind: 'reading' });
    expect(parsed).toEqual({ title: 'Intro', kind: 'reading' });
  });

  it('trims the title', () => {
    expect(CreateAcademyLessonRequestSchema.parse({ title: '  Intro  ', kind: 'quiz' }).title).toBe(
      'Intro',
    );
  });

  it('rejects an empty title', () => {
    expect(
      CreateAcademyLessonRequestSchema.safeParse({ title: '   ', kind: 'video' }).success,
    ).toBe(false);
  });

  it('rejects a title past the cap', () => {
    expect(
      CreateAcademyLessonRequestSchema.safeParse({
        title: 'x'.repeat(ACADEMY_LESSON_TITLE_MAX_LENGTH + 1),
        kind: 'video',
      }).success,
    ).toBe(false);
  });

  it('rejects body markdown past the cap', () => {
    expect(
      CreateAcademyLessonRequestSchema.safeParse({
        title: 'Intro',
        kind: 'reading',
        bodyMarkdown: 'x'.repeat(ACADEMY_LESSON_BODY_MARKDOWN_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe('UpdateAcademyLessonRequestSchema', () => {
  it('accepts a single-field update', () => {
    expect(UpdateAcademyLessonRequestSchema.parse({ title: 'Renamed' })).toEqual({
      title: 'Renamed',
    });
  });

  it('accepts clearing nullable content fields', () => {
    const parsed = UpdateAcademyLessonRequestSchema.parse({
      contentKey: null,
      durationMinutes: null,
    });
    expect(parsed.contentKey).toBeNull();
    expect(parsed.durationMinutes).toBeNull();
  });

  it('rejects an empty body (at least one field)', () => {
    expect(UpdateAcademyLessonRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    expect(UpdateAcademyLessonRequestSchema.safeParse({ name: 'x' }).success).toBe(false);
  });
});

describe('lesson response envelopes', () => {
  it('AcademyLessonResponseSchema wraps a lesson', () => {
    expect(AcademyLessonResponseSchema.parse({ lesson: validRecord() }).lesson.id).toBe('lesson_1');
  });

  it('AcademyLessonsListResponseSchema wraps an array', () => {
    expect(
      AcademyLessonsListResponseSchema.parse({
        lessons: [validRecord(), validRecord({ id: 'lesson_2' })],
      }).lessons,
    ).toHaveLength(2);
  });
});
