import { describe, expect, it } from 'vitest';

import {
  ADMIN_ROLE_APPROVAL_STATUSES,
  AdminRoleApprovalRecordSchema,
  AdminRoleApprovalResponseSchema,
  AdminRoleApprovalsListQuerySchema,
  AdminRoleApprovalsListResponseSchema,
  DecideRoleApprovalRequestSchema,
  RequestRoleApprovalRequestSchema,
} from '../http/admin-role-approvals.schema';

/**
 * Contract tests for the admin role-APPROVAL DTOs (TS-294; CLAUDE.md §3.2).
 * Pins the reviewer-flow wire shapes: required requester reason, strict
 * objects, the discriminated scope union reuse, and the status enum.
 */

const record = {
  id: 'apr_1',
  userId: 'user_1',
  roleName: 'finance',
  scope: { type: 'global' as const },
  expiresAt: null,
  requestedByUserId: 'admin_1',
  reason: 'quarter-close coverage',
  status: 'pending' as const,
  approvedByUserId: null,
  decidedAt: null,
  decisionNote: null,
  userRoleId: null,
  createdAt: '2026-07-01T12:00:00.000Z',
};

describe('AdminRoleApprovalRecordSchema', () => {
  it('accepts a pending record', () => {
    expect(AdminRoleApprovalRecordSchema.safeParse(record).success).toBe(true);
  });

  it('accepts a decided record carrying decider + minted assignment', () => {
    const decided = {
      ...record,
      status: 'approved' as const,
      approvedByUserId: 'admin_2',
      decidedAt: '2026-07-01T13:00:00.000Z',
      decisionNote: 'verified with the requester',
      userRoleId: 'ur_9',
    };
    expect(AdminRoleApprovalRecordSchema.safeParse(decided).success).toBe(true);
  });

  it('covers all four statuses and rejects unknown ones', () => {
    for (const status of ADMIN_ROLE_APPROVAL_STATUSES) {
      expect(AdminRoleApprovalRecordSchema.safeParse({ ...record, status }).success).toBe(true);
    }
    expect(AdminRoleApprovalRecordSchema.safeParse({ ...record, status: 'granted' }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields (.strict)', () => {
    expect(AdminRoleApprovalRecordSchema.safeParse({ ...record, email: 'x@y.z' }).success).toBe(
      false,
    );
  });

  it('rejects a malformed scope (tenant without tenantId)', () => {
    expect(
      AdminRoleApprovalRecordSchema.safeParse({ ...record, scope: { type: 'tenant' } }).success,
    ).toBe(false);
  });
});

describe('RequestRoleApprovalRequestSchema', () => {
  const valid = {
    userId: 'user_1',
    roleName: 'super_admin',
    scope: { type: 'global' as const },
    reason: 'incident-response elevation for the payments outage',
  };

  it('accepts a valid request', () => {
    expect(RequestRoleApprovalRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('REQUIRES a reason — privilege escalation carries a why', () => {
    const { reason: _omit, ...without } = valid;
    expect(RequestRoleApprovalRequestSchema.safeParse(without).success).toBe(false);
    expect(RequestRoleApprovalRequestSchema.safeParse({ ...valid, reason: '   ' }).success).toBe(
      false,
    );
  });

  it('accepts an optional future expiry as an ISO datetime only', () => {
    expect(
      RequestRoleApprovalRequestSchema.safeParse({
        ...valid,
        expiresAt: '2027-01-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      RequestRoleApprovalRequestSchema.safeParse({ ...valid, expiresAt: 'next week' }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    expect(RequestRoleApprovalRequestSchema.safeParse({ ...valid, approve: true }).success).toBe(
      false,
    );
  });
});

describe('list query / responses / decide', () => {
  it('list query takes an optional status filter and rejects unknown values', () => {
    expect(AdminRoleApprovalsListQuerySchema.safeParse({}).success).toBe(true);
    expect(AdminRoleApprovalsListQuerySchema.safeParse({ status: 'pending' }).success).toBe(true);
    expect(AdminRoleApprovalsListQuerySchema.safeParse({ status: 'open' }).success).toBe(false);
  });

  it('list + envelope responses parse', () => {
    expect(AdminRoleApprovalsListResponseSchema.safeParse({ approvals: [record] }).success).toBe(
      true,
    );
    expect(AdminRoleApprovalResponseSchema.safeParse({ approval: record }).success).toBe(true);
  });

  it('decide body allows an optional trimmed note and nothing else', () => {
    expect(DecideRoleApprovalRequestSchema.safeParse({}).success).toBe(true);
    expect(DecideRoleApprovalRequestSchema.safeParse({ note: 'checked' }).success).toBe(true);
    expect(DecideRoleApprovalRequestSchema.safeParse({ note: '  ' }).success).toBe(false);
    expect(DecideRoleApprovalRequestSchema.safeParse({ approve: true }).success).toBe(false);
  });
});
