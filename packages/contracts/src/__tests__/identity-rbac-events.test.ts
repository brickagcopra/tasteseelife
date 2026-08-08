import { describe, expect, it } from 'vitest';

import {
  IDENTITY_ROLE_ASSIGNMENT_APPROVAL_DECIDED,
  IDENTITY_ROLE_ASSIGNMENT_APPROVAL_REQUESTED,
  IDENTITY_ROLE_ASSIGNMENT_EXPIRED,
  IdentityRoleAssignmentApprovalDecidedSchema,
  IdentityRoleAssignmentApprovalRequestedSchema,
  IdentityRoleAssignmentExpiredSchema,
  eventRegistry,
  getEventSchema,
} from '../events';

/**
 * Contract tests for the identity RBAC expiry event (TS-293).
 *
 * Pins the wire shape (`.strict()`), the envelope, the flat scope encoding,
 * and the registry wiring — so a producer edit is a parse error and the
 * (carved) `service-notification` consumer can map the payload 1:1.
 */
describe('identity rbac event registry wiring', () => {
  it('registers the event under its dotted constant', () => {
    expect(eventRegistry[IDENTITY_ROLE_ASSIGNMENT_EXPIRED]).toBe(
      IdentityRoleAssignmentExpiredSchema,
    );
    expect(getEventSchema(IDENTITY_ROLE_ASSIGNMENT_EXPIRED)).toBe(
      IdentityRoleAssignmentExpiredSchema,
    );
  });

  it('uses a past-tense dotted name', () => {
    expect(IDENTITY_ROLE_ASSIGNMENT_EXPIRED).toBe('identity.role_assignment.expired');
    expect(IDENTITY_ROLE_ASSIGNMENT_EXPIRED).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  });
});

describe('IdentityRoleAssignmentExpired event', () => {
  const valid = {
    eventId: 'evt_1',
    occurredAt: '2026-07-01T12:00:00.000Z',
    assignmentId: 'ur_1',
    userId: 'user_1',
    roleName: 'operations_manager',
    scopeType: 'tenant',
    scopeId: 'tenant_abc',
    expiresAt: '2026-07-01T00:00:00.000Z',
    revokedAt: '2026-07-01T12:00:00.000Z',
  };

  it('accepts a valid tenant-scoped payload', () => {
    expect(IdentityRoleAssignmentExpiredSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a global-scoped payload with null scopeId', () => {
    const parsed = IdentityRoleAssignmentExpiredSchema.safeParse({
      ...valid,
      scopeType: 'global',
      scopeId: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown scope type', () => {
    expect(
      IdentityRoleAssignmentExpiredSchema.safeParse({ ...valid, scopeType: 'region' }).success,
    ).toBe(false);
  });

  it('rejects an unknown field (.strict)', () => {
    expect(
      IdentityRoleAssignmentExpiredSchema.safeParse({ ...valid, email: 'x@y.z' }).success,
    ).toBe(false);
  });

  it('requires expiresAt and revokedAt to be datetimes', () => {
    expect(
      IdentityRoleAssignmentExpiredSchema.safeParse({ ...valid, expiresAt: 'yesterday' }).success,
    ).toBe(false);
    expect(IdentityRoleAssignmentExpiredSchema.safeParse({ ...valid, revokedAt: '' }).success).toBe(
      false,
    );
  });

  it('requires the assignment / user / role identifiers', () => {
    for (const key of ['assignmentId', 'userId', 'roleName'] as const) {
      const { [key]: _omit, ...without } = valid;
      expect(IdentityRoleAssignmentExpiredSchema.safeParse(without).success).toBe(false);
    }
  });
});

describe('role-approval events (TS-294)', () => {
  const requested = {
    eventId: 'evt_2',
    occurredAt: '2026-07-01T12:00:00.000Z',
    approvalId: 'apr_1',
    userId: 'user_1',
    roleName: 'finance',
    scopeType: 'global',
    scopeId: null,
    expiresAt: null,
    requestedByUserId: 'admin_1',
  };

  it('registers both events under their dotted constants', () => {
    expect(eventRegistry[IDENTITY_ROLE_ASSIGNMENT_APPROVAL_REQUESTED]).toBe(
      IdentityRoleAssignmentApprovalRequestedSchema,
    );
    expect(eventRegistry[IDENTITY_ROLE_ASSIGNMENT_APPROVAL_DECIDED]).toBe(
      IdentityRoleAssignmentApprovalDecidedSchema,
    );
    expect(getEventSchema(IDENTITY_ROLE_ASSIGNMENT_APPROVAL_DECIDED)).toBe(
      IdentityRoleAssignmentApprovalDecidedSchema,
    );
  });

  it('uses past-tense dotted names', () => {
    expect(IDENTITY_ROLE_ASSIGNMENT_APPROVAL_REQUESTED).toBe(
      'identity.role_assignment_approval.requested',
    );
    expect(IDENTITY_ROLE_ASSIGNMENT_APPROVAL_DECIDED).toBe(
      'identity.role_assignment_approval.decided',
    );
  });

  it('accepts a valid requested payload and rejects unknown fields', () => {
    expect(IdentityRoleAssignmentApprovalRequestedSchema.safeParse(requested).success).toBe(true);
    expect(
      IdentityRoleAssignmentApprovalRequestedSchema.safeParse({ ...requested, email: 'x@y.z' })
        .success,
    ).toBe(false);
  });

  it('requires requestedByUserId on the requested payload', () => {
    const { requestedByUserId: _omit, ...without } = requested;
    expect(IdentityRoleAssignmentApprovalRequestedSchema.safeParse(without).success).toBe(false);
  });

  const decided = {
    ...requested,
    status: 'approved',
    decidedByUserId: 'admin_2',
    decidedAt: '2026-07-01T13:00:00.000Z',
    userRoleId: 'ur_9',
  };

  it('accepts a valid approved payload with the minted assignment id', () => {
    expect(IdentityRoleAssignmentApprovalDecidedSchema.safeParse(decided).success).toBe(true);
  });

  it('accepts a rejected payload with no minted assignment and a null decider for expiry', () => {
    expect(
      IdentityRoleAssignmentApprovalDecidedSchema.safeParse({
        ...decided,
        status: 'rejected',
        userRoleId: null,
      }).success,
    ).toBe(true);
    expect(
      IdentityRoleAssignmentApprovalDecidedSchema.safeParse({
        ...decided,
        status: 'expired',
        decidedByUserId: null,
        userRoleId: null,
      }).success,
    ).toBe(true);
  });

  it('rejects a pending status on the decided event', () => {
    expect(
      IdentityRoleAssignmentApprovalDecidedSchema.safeParse({ ...decided, status: 'pending' })
        .success,
    ).toBe(false);
  });
});
