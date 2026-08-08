import { describe, expect, it } from 'vitest';

import {
  ConciergeAssignmentRecordSchema,
  ConciergeAssignmentSnapshotResponseSchema,
  ConciergeAssignmentsListResponseSchema,
  CONCIERGE_ASSIGNMENT_DISPLAY_NAME_MAX_LENGTH,
  CONCIERGE_ASSIGNMENT_LIST_LIMIT_DEFAULT,
  CONCIERGE_ASSIGNMENT_LIST_LIMIT_MAX,
  CreateConciergeAssignmentRequestSchema,
  CreateConciergeAssignmentResponseSchema,
  EndConciergeAssignmentResponseSchema,
  ListConciergeAssignmentsQuerySchema,
} from '../http/concierge-assignment.schema';

const T0 = '2026-06-01T09:00:00.000Z';

function buildRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ca_abc',
    householdId: 'hh_abc',
    primaryConciergeUserId: 'user_primary',
    primaryConciergeDisplayName: 'Avery Concierge',
    backupConciergeUserId: null,
    backupConciergeDisplayName: null,
    status: 'active',
    assignedByUserId: 'user_admin',
    startedAt: T0,
    endedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe('ConciergeAssignmentRecordSchema', () => {
  it('parses an active assignment with no backup', () => {
    const parsed = ConciergeAssignmentRecordSchema.parse(buildRecord());
    expect(parsed.status).toBe('active');
    expect(parsed.backupConciergeUserId).toBeNull();
    expect(parsed.endedAt).toBeNull();
  });

  it('accepts a backup concierge when both id + name are present', () => {
    const parsed = ConciergeAssignmentRecordSchema.parse(
      buildRecord({
        backupConciergeUserId: 'user_backup',
        backupConciergeDisplayName: 'Blair Backup',
      }),
    );
    expect(parsed.backupConciergeUserId).toBe('user_backup');
    expect(parsed.backupConciergeDisplayName).toBe('Blair Backup');
  });

  it('parses an ended assignment with an endedAt instant', () => {
    const parsed = ConciergeAssignmentRecordSchema.parse(
      buildRecord({ status: 'ended', endedAt: T0 }),
    );
    expect(parsed.status).toBe('ended');
    expect(parsed.endedAt).toBe(T0);
  });

  it('rejects a backup id without a backup name', () => {
    expect(() =>
      ConciergeAssignmentRecordSchema.parse(buildRecord({ backupConciergeUserId: 'user_backup' })),
    ).toThrow();
  });

  it('rejects a backup name without a backup id', () => {
    expect(() =>
      ConciergeAssignmentRecordSchema.parse(
        buildRecord({ backupConciergeDisplayName: 'Blair Backup' }),
      ),
    ).toThrow();
  });

  it('rejects an unknown status', () => {
    expect(() =>
      ConciergeAssignmentRecordSchema.parse(buildRecord({ status: 'paused' })),
    ).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => ConciergeAssignmentRecordSchema.parse(buildRecord({ extra: true }))).toThrow();
  });
});

describe('CreateConciergeAssignmentRequestSchema', () => {
  it('parses a primary-only assignment', () => {
    const parsed = CreateConciergeAssignmentRequestSchema.parse({
      householdId: 'hh_abc',
      primaryConciergeUserId: 'user_primary',
      primaryConciergeDisplayName: 'Avery Concierge',
    });
    expect(parsed.backupConciergeUserId).toBeUndefined();
    expect(parsed.assignedByUserId).toBeUndefined();
  });

  it('parses a primary + backup + attribution', () => {
    const parsed = CreateConciergeAssignmentRequestSchema.parse({
      householdId: 'hh_abc',
      primaryConciergeUserId: 'user_primary',
      primaryConciergeDisplayName: 'Avery Concierge',
      backupConciergeUserId: 'user_backup',
      backupConciergeDisplayName: 'Blair Backup',
      assignedByUserId: 'user_admin',
    });
    expect(parsed.backupConciergeUserId).toBe('user_backup');
  });

  it('trims the display name', () => {
    const parsed = CreateConciergeAssignmentRequestSchema.parse({
      householdId: 'hh_abc',
      primaryConciergeUserId: 'user_primary',
      primaryConciergeDisplayName: '  Avery Concierge  ',
    });
    expect(parsed.primaryConciergeDisplayName).toBe('Avery Concierge');
  });

  it('rejects a backup id without a backup name', () => {
    expect(
      CreateConciergeAssignmentRequestSchema.safeParse({
        householdId: 'hh_abc',
        primaryConciergeUserId: 'user_primary',
        primaryConciergeDisplayName: 'Avery Concierge',
        backupConciergeUserId: 'user_backup',
      }).success,
    ).toBe(false);
  });

  it('rejects a backup equal to the primary', () => {
    const result = CreateConciergeAssignmentRequestSchema.safeParse({
      householdId: 'hh_abc',
      primaryConciergeUserId: 'user_primary',
      primaryConciergeDisplayName: 'Avery Concierge',
      backupConciergeUserId: 'user_primary',
      backupConciergeDisplayName: 'Avery Concierge',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('backupConciergeUserId'))).toBe(true);
    }
  });

  it('rejects an empty primary display name', () => {
    expect(
      CreateConciergeAssignmentRequestSchema.safeParse({
        householdId: 'hh_abc',
        primaryConciergeUserId: 'user_primary',
        primaryConciergeDisplayName: '   ',
      }).success,
    ).toBe(false);
  });

  it('rejects a display name over the cap', () => {
    expect(
      CreateConciergeAssignmentRequestSchema.safeParse({
        householdId: 'hh_abc',
        primaryConciergeUserId: 'user_primary',
        primaryConciergeDisplayName: 'x'.repeat(CONCIERGE_ASSIGNMENT_DISPLAY_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      CreateConciergeAssignmentRequestSchema.safeParse({
        householdId: 'hh_abc',
        primaryConciergeUserId: 'user_primary',
        primaryConciergeDisplayName: 'Avery Concierge',
        smuggled: 1,
      }).success,
    ).toBe(false);
  });
});

describe('CreateConciergeAssignmentResponseSchema', () => {
  it('wraps the created assignment', () => {
    const parsed = CreateConciergeAssignmentResponseSchema.parse({ assignment: buildRecord() });
    expect(parsed.assignment.id).toBe('ca_abc');
  });
});

describe('ConciergeAssignmentSnapshotResponseSchema', () => {
  it('parses a null assignment (no dedicated concierge)', () => {
    const parsed = ConciergeAssignmentSnapshotResponseSchema.parse({
      householdId: 'hh_abc',
      assignment: null,
    });
    expect(parsed.assignment).toBeNull();
  });

  it('parses a present assignment', () => {
    const parsed = ConciergeAssignmentSnapshotResponseSchema.parse({
      householdId: 'hh_abc',
      assignment: buildRecord(),
    });
    expect(parsed.assignment?.id).toBe('ca_abc');
  });
});

describe('ListConciergeAssignmentsQuerySchema', () => {
  it('requires a householdId and defaults the limit', () => {
    const parsed = ListConciergeAssignmentsQuerySchema.parse({ householdId: 'hh_abc' });
    expect(parsed.limit).toBe(CONCIERGE_ASSIGNMENT_LIST_LIMIT_DEFAULT);
    expect(parsed.activeOnly).toBeUndefined();
  });

  it('rejects a missing householdId', () => {
    expect(ListConciergeAssignmentsQuerySchema.safeParse({}).success).toBe(false);
  });

  it('coerces the limit string and the activeOnly flag', () => {
    const parsed = ListConciergeAssignmentsQuerySchema.parse({
      householdId: 'hh_abc',
      activeOnly: 'true',
      limit: '10',
    });
    expect(parsed.limit).toBe(10);
    expect(parsed.activeOnly).toBe(true);
  });

  it('rejects a limit over the cap', () => {
    expect(
      ListConciergeAssignmentsQuerySchema.safeParse({
        householdId: 'hh_abc',
        limit: String(CONCIERGE_ASSIGNMENT_LIST_LIMIT_MAX + 1),
      }).success,
    ).toBe(false);
  });
});

describe('ConciergeAssignmentsListResponseSchema', () => {
  it('parses an array of assignments', () => {
    const parsed = ConciergeAssignmentsListResponseSchema.parse({
      assignments: [buildRecord(), buildRecord({ id: 'ca_def', status: 'ended', endedAt: T0 })],
    });
    expect(parsed.assignments).toHaveLength(2);
  });
});

describe('EndConciergeAssignmentResponseSchema', () => {
  it('parses each idempotent outcome', () => {
    for (const outcome of ['ended', 'already_ended', 'not_found'] as const) {
      const parsed = EndConciergeAssignmentResponseSchema.parse({
        outcome,
        assignmentId: 'ca_abc',
      });
      expect(parsed.outcome).toBe(outcome);
    }
  });

  it('rejects an unknown outcome', () => {
    expect(
      EndConciergeAssignmentResponseSchema.safeParse({
        outcome: 'archived',
        assignmentId: 'ca_abc',
      }).success,
    ).toBe(false);
  });
});
