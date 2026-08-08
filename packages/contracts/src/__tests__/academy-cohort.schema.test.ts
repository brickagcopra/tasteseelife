import { describe, expect, it } from 'vitest';

import {
  ACADEMY_COHORT_STATUS_TRANSITIONS,
  ACADEMY_COHORT_TERMINAL_STATUSES,
  ACADEMY_COHORTS_LIST_LIMIT_DEFAULT,
  AcademyCohortRecordSchema,
  AcademyCohortResponseSchema,
  AcademyCohortsListResponseSchema,
  CreateAcademyCohortRequestSchema,
  ListAcademyCohortsQuerySchema,
  UpdateAcademyCohortRequestSchema,
  canTransitionAcademyCohort,
  isAcademyCohortTerminal,
  type AcademyCohortStatus,
} from '../http/academy-cohort.schema';

const START = '2026-06-01T18:00:00.000Z';
const END = '2026-06-30T20:00:00.000Z';

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cohort_1',
    courseId: 'course_1',
    name: 'Spring 2026 — Tuesday evenings',
    status: 'scheduled',
    startsAt: START,
    endsAt: END,
    capacity: 12,
    instructorUserId: 'user_instructor',
    createdAt: START,
    updatedAt: START,
    deletedAt: null,
    ...overrides,
  };
}

describe('AcademyCohortRecordSchema', () => {
  it('parses a complete record', () => {
    expect(AcademyCohortRecordSchema.parse(validRecord()).name).toContain('Spring 2026');
  });

  it('accepts a null end / capacity / instructor (uncapped, open-ended, unassigned)', () => {
    const parsed = AcademyCohortRecordSchema.parse(
      validRecord({ endsAt: null, capacity: null, instructorUserId: null }),
    );
    expect(parsed.endsAt).toBeNull();
    expect(parsed.capacity).toBeNull();
    expect(parsed.instructorUserId).toBeNull();
  });

  it('rejects an unknown field (strict)', () => {
    expect(AcademyCohortRecordSchema.safeParse(validRecord({ extra: 1 })).success).toBe(false);
  });
});

describe('CreateAcademyCohortRequestSchema', () => {
  it('defaults status to scheduled', () => {
    expect(
      CreateAcademyCohortRequestSchema.parse({ name: 'Fall 2026', startsAt: START }).status,
    ).toBe('scheduled');
  });

  it('allows creating directly as open', () => {
    expect(
      CreateAcademyCohortRequestSchema.parse({ name: 'N', startsAt: START, status: 'open' }).status,
    ).toBe('open');
  });

  it('rejects creating into a running / terminal status', () => {
    for (const status of ['in_progress', 'completed', 'canceled']) {
      expect(
        CreateAcademyCohortRequestSchema.safeParse({ name: 'N', startsAt: START, status }).success,
      ).toBe(false);
    }
  });

  it('rejects endsAt before startsAt', () => {
    expect(
      CreateAcademyCohortRequestSchema.safeParse({ name: 'N', startsAt: END, endsAt: START })
        .success,
    ).toBe(false);
  });
});

describe('UpdateAcademyCohortRequestSchema', () => {
  it('accepts a single-field update', () => {
    expect(UpdateAcademyCohortRequestSchema.parse({ status: 'open' })).toEqual({ status: 'open' });
  });

  it('accepts clearing nullable fields', () => {
    const parsed = UpdateAcademyCohortRequestSchema.parse({
      capacity: null,
      instructorUserId: null,
    });
    expect(parsed.capacity).toBeNull();
    expect(parsed.instructorUserId).toBeNull();
  });

  it('rejects an empty body', () => {
    expect(UpdateAcademyCohortRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a merged endsAt before startsAt', () => {
    expect(
      UpdateAcademyCohortRequestSchema.safeParse({ startsAt: END, endsAt: START }).success,
    ).toBe(false);
  });
});

describe('ListAcademyCohortsQuerySchema', () => {
  it('defaults the limit', () => {
    expect(ListAcademyCohortsQuerySchema.parse({}).limit).toBe(ACADEMY_COHORTS_LIST_LIMIT_DEFAULT);
  });

  it('coerces a string limit', () => {
    expect(ListAcademyCohortsQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });
});

describe('canTransitionAcademyCohort / isAcademyCohortTerminal', () => {
  it('follows the documented progression', () => {
    expect(canTransitionAcademyCohort('scheduled', 'open')).toBe(true);
    expect(canTransitionAcademyCohort('open', 'in_progress')).toBe(true);
    expect(canTransitionAcademyCohort('in_progress', 'completed')).toBe(true);
  });

  it('allows cancel from any non-terminal state', () => {
    for (const from of ['scheduled', 'open', 'in_progress'] as AcademyCohortStatus[]) {
      expect(canTransitionAcademyCohort(from, 'canceled')).toBe(true);
    }
  });

  it('disallows skipping a stage and re-opening a terminal cohort', () => {
    expect(canTransitionAcademyCohort('scheduled', 'completed')).toBe(false);
    expect(canTransitionAcademyCohort('completed', 'open')).toBe(false);
    expect(canTransitionAcademyCohort('canceled', 'scheduled')).toBe(false);
  });

  it('flags the two terminal statuses', () => {
    expect(ACADEMY_COHORT_TERMINAL_STATUSES).toEqual(['completed', 'canceled']);
    expect(isAcademyCohortTerminal('completed')).toBe(true);
    expect(isAcademyCohortTerminal('canceled')).toBe(true);
    expect(isAcademyCohortTerminal('open')).toBe(false);
  });

  it('the transition table has no outbound edges from terminal states', () => {
    expect(ACADEMY_COHORT_STATUS_TRANSITIONS.completed).toEqual([]);
    expect(ACADEMY_COHORT_STATUS_TRANSITIONS.canceled).toEqual([]);
  });
});

describe('cohort response envelopes', () => {
  it('AcademyCohortResponseSchema wraps a cohort', () => {
    expect(AcademyCohortResponseSchema.parse({ cohort: validRecord() }).cohort.id).toBe('cohort_1');
  });

  it('AcademyCohortsListResponseSchema wraps an array', () => {
    expect(
      AcademyCohortsListResponseSchema.parse({ cohorts: [validRecord()] }).cohorts,
    ).toHaveLength(1);
  });
});
