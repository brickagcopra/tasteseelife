import { describe, expect, it } from 'vitest';

import {
  ADMIN_ROLE_ASSIGNMENTS_BULK_MAX_ROWS,
  ADMIN_ROLE_ASSIGNMENTS_SENSITIVE_ROLES,
  AdminRoleAssignmentRecordSchema,
  AdminRoleAssignmentsListQuerySchema,
  AdminRoleAssignmentsListResponseSchema,
  BulkRoleAssignmentOutcomeSchema,
  BulkRoleAssignmentRowSchema,
  BulkRoleAssignmentVerdictSchema,
  BulkRoleAssignmentsCommitRequestSchema,
  BulkRoleAssignmentsPreviewRequestSchema,
  BulkRoleAssignmentsPreviewResponseSchema,
  GrantRoleAssignmentRequestSchema,
  RevokeRoleAssignmentRequestSchema,
} from '../http/admin-role-assignments.schema';

const RECORD = {
  id: 'ur_1',
  userId: 'user_1',
  roleName: 'customer_support',
  scope: { type: 'global' },
  active: true,
  grantedByUserId: 'admin_1',
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-07-01T12:00:00.000Z',
};

const ROW = {
  userId: 'user_1',
  roleName: 'customer_support',
  scopeType: 'global',
  scopeId: null,
  expiresAt: null,
};

describe('AdminRoleAssignmentRecordSchema', () => {
  it('accepts a global-scope record and rejects unknown fields', () => {
    expect(AdminRoleAssignmentRecordSchema.safeParse(RECORD).success).toBe(true);
    expect(AdminRoleAssignmentRecordSchema.safeParse({ ...RECORD, extra: 1 }).success).toBe(false);
  });

  it('accepts tenant / household scopes and rejects a malformed one', () => {
    expect(
      AdminRoleAssignmentRecordSchema.safeParse({
        ...RECORD,
        scope: { type: 'tenant', tenantId: 't_1' },
      }).success,
    ).toBe(true);
    expect(
      AdminRoleAssignmentRecordSchema.safeParse({
        ...RECORD,
        scope: { type: 'household', householdId: 'hh_1' },
      }).success,
    ).toBe(true);
    // Global scope must not carry an id (strict discriminated union).
    expect(
      AdminRoleAssignmentRecordSchema.safeParse({
        ...RECORD,
        scope: { type: 'global', tenantId: 't_1' },
      }).success,
    ).toBe(false);
    // Tenant scope requires its id.
    expect(
      AdminRoleAssignmentRecordSchema.safeParse({
        ...RECORD,
        scope: { type: 'tenant' },
      }).success,
    ).toBe(false);
  });
});

describe('AdminRoleAssignmentsListQuerySchema', () => {
  it('coerces includeInactive and rejects unknown params', () => {
    expect(
      AdminRoleAssignmentsListQuerySchema.parse({ includeInactive: 'true' }).includeInactive,
    ).toBe(true);
    expect(AdminRoleAssignmentsListQuerySchema.safeParse({ other: '1' }).success).toBe(false);
  });
});

describe('AdminRoleAssignmentsListResponseSchema', () => {
  it('accepts a list envelope', () => {
    expect(
      AdminRoleAssignmentsListResponseSchema.safeParse({ assignments: [RECORD] }).success,
    ).toBe(true);
  });
});

describe('GrantRoleAssignmentRequestSchema', () => {
  it('accepts a minimal grant and one with expiry + reason', () => {
    expect(
      GrantRoleAssignmentRequestSchema.safeParse({
        userId: 'user_1',
        roleName: 'customer_support',
        scope: { type: 'global' },
      }).success,
    ).toBe(true);
    expect(
      GrantRoleAssignmentRequestSchema.safeParse({
        userId: 'user_1',
        roleName: 'customer_support',
        scope: { type: 'tenant', tenantId: 't_1' },
        expiresAt: '2027-01-01T00:00:00.000Z',
        reason: 'seasonal contract',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-datetime expiry and unknown fields', () => {
    expect(
      GrantRoleAssignmentRequestSchema.safeParse({
        userId: 'user_1',
        roleName: 'customer_support',
        scope: { type: 'global' },
        expiresAt: 'tomorrow',
      }).success,
    ).toBe(false);
    expect(
      GrantRoleAssignmentRequestSchema.safeParse({
        userId: 'user_1',
        roleName: 'customer_support',
        scope: { type: 'global' },
        isSystem: true,
      }).success,
    ).toBe(false);
  });
});

describe('RevokeRoleAssignmentRequestSchema', () => {
  it('accepts an empty body and trims the reason', () => {
    expect(RevokeRoleAssignmentRequestSchema.safeParse({}).success).toBe(true);
    expect(RevokeRoleAssignmentRequestSchema.parse({ reason: '  offboarded  ' }).reason).toBe(
      'offboarded',
    );
  });
});

describe('BulkRoleAssignmentRowSchema', () => {
  it('accepts a loose-but-bounded row (semantics are validated server-side per row)', () => {
    // A nonsense scopeType passes the SCHEMA — the service turns it
    // into a per-row verdict instead of a batch 400.
    expect(BulkRoleAssignmentRowSchema.safeParse({ ...ROW, scopeType: 'galaxy' }).success).toBe(
      true,
    );
  });

  it('trims fields and rejects empties / oversizes', () => {
    expect(BulkRoleAssignmentRowSchema.parse({ ...ROW, userId: ' user_1 ' }).userId).toBe('user_1');
    expect(BulkRoleAssignmentRowSchema.safeParse({ ...ROW, userId: '' }).success).toBe(false);
    expect(BulkRoleAssignmentRowSchema.safeParse({ ...ROW, userId: 'x'.repeat(65) }).success).toBe(
      false,
    );
  });
});

describe('bulk request bounds', () => {
  it('rejects an empty batch and one over the row cap', () => {
    expect(BulkRoleAssignmentsPreviewRequestSchema.safeParse({ rows: [] }).success).toBe(false);
    const oversized = Array.from({ length: ADMIN_ROLE_ASSIGNMENTS_BULK_MAX_ROWS + 1 }, () => ROW);
    expect(BulkRoleAssignmentsPreviewRequestSchema.safeParse({ rows: oversized }).success).toBe(
      false,
    );
    expect(BulkRoleAssignmentsCommitRequestSchema.safeParse({ rows: [ROW] }).success).toBe(true);
  });
});

describe('verdicts and outcomes', () => {
  it('accepts an ok verdict with its normalized grant and an error verdict without one', () => {
    expect(
      BulkRoleAssignmentVerdictSchema.safeParse({
        index: 0,
        ok: true,
        errors: [],
        normalized: {
          userId: 'user_1',
          roleName: 'customer_support',
          scope: { type: 'global' },
          expiresAt: null,
        },
      }).success,
    ).toBe(true);
    expect(
      BulkRoleAssignmentVerdictSchema.safeParse({
        index: 3,
        ok: false,
        errors: [{ field: 'roleName', message: 'no role with this name' }],
        normalized: null,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown error field and an unknown outcome status', () => {
    expect(
      BulkRoleAssignmentVerdictSchema.safeParse({
        index: 0,
        ok: false,
        errors: [{ field: 'shoeSize', message: 'nope' }],
        normalized: null,
      }).success,
    ).toBe(false);
    expect(
      BulkRoleAssignmentOutcomeSchema.safeParse({
        index: 0,
        status: 'exploded',
        assignmentId: null,
        message: null,
      }).success,
    ).toBe(false);
  });

  it('accepts a preview response with counts', () => {
    expect(
      BulkRoleAssignmentsPreviewResponseSchema.safeParse({
        verdicts: [],
        okCount: 0,
        errorCount: 0,
      }).success,
    ).toBe(true);
  });
});

describe('sensitive-role mirror', () => {
  it('names exactly the reviewer-approval roles', () => {
    expect([...ADMIN_ROLE_ASSIGNMENTS_SENSITIVE_ROLES]).toEqual(['super_admin', 'finance']);
  });
});
