import { describe, expect, it } from 'vitest';

import {
  ADMIN_USERS_ACTION_NOTE_MAX_LENGTH,
  ADMIN_USERS_REINSTATE_REASONS,
  ADMIN_USERS_SUSPEND_REASONS,
  AdminUserActionResponseSchema,
  AdminUserActionStateSnapshotSchema,
  ReinstateUserRequestSchema,
  SuspendUserRequestSchema,
  UnlockUserRequestSchema,
  type AdminUserActionResponse,
  type AdminUserActionStateSnapshot,
  type AdminUserSummary,
} from '../http';

const NOW_ISO = '2026-05-18T12:00:00.000Z';

const sampleSummary: AdminUserSummary = {
  id: 'usr_abc',
  email: 'alice@example.com',
  phone: null,
  status: 'suspended',
  mfaEnabled: false,
  emailVerifiedAt: null,
  activeRoleCount: 1,
  holdsAdminRole: false,
  currentlyLocked: false,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const cleanState: AdminUserActionStateSnapshot = {
  status: 'active',
  failedLoginCount: 0,
  lastFailedLoginAt: null,
  lockedUntil: null,
  currentlyLocked: false,
};

const lockedState: AdminUserActionStateSnapshot = {
  status: 'active',
  failedLoginCount: 7,
  lastFailedLoginAt: NOW_ISO,
  lockedUntil: NOW_ISO,
  currentlyLocked: true,
};

describe('SuspendUserRequestSchema', () => {
  it('accepts every documented suspend reason', () => {
    for (const reason of ADMIN_USERS_SUSPEND_REASONS) {
      const parsed = SuspendUserRequestSchema.safeParse({ reason });
      expect(parsed.success, `reason=${reason}`).toBe(true);
    }
  });

  it('accepts a note within the length cap', () => {
    const parsed = SuspendUserRequestSchema.safeParse({
      reason: 'trust_safety',
      note: 'card chargeback investigation; ticket TS-99',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty note', () => {
    const parsed = SuspendUserRequestSchema.safeParse({
      reason: 'trust_safety',
      note: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a note past the length cap', () => {
    const parsed = SuspendUserRequestSchema.safeParse({
      reason: 'trust_safety',
      note: 'a'.repeat(ADMIN_USERS_ACTION_NOTE_MAX_LENGTH + 1),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown reason', () => {
    const parsed = SuspendUserRequestSchema.safeParse({ reason: 'whatever' });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const parsed = SuspendUserRequestSchema.safeParse({
      reason: 'trust_safety',
      severity: 'high',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ReinstateUserRequestSchema', () => {
  it('accepts every documented reinstate reason', () => {
    for (const reason of ADMIN_USERS_REINSTATE_REASONS) {
      const parsed = ReinstateUserRequestSchema.safeParse({ reason });
      expect(parsed.success, `reason=${reason}`).toBe(true);
    }
  });

  it('rejects a missing reason', () => {
    const parsed = ReinstateUserRequestSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const parsed = ReinstateUserRequestSchema.safeParse({
      reason: 'user_request',
      ackBy: 'alice',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('UnlockUserRequestSchema', () => {
  it('accepts an empty body', () => {
    const parsed = UnlockUserRequestSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('accepts a note', () => {
    const parsed = UnlockUserRequestSchema.safeParse({ note: 'support ticket' });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    const parsed = UnlockUserRequestSchema.safeParse({ reason: 'unspecified' });
    expect(parsed.success).toBe(false);
  });
});

describe('AdminUserActionStateSnapshotSchema', () => {
  it('round-trips a clean state', () => {
    const parsed = AdminUserActionStateSnapshotSchema.safeParse(cleanState);
    expect(parsed.success).toBe(true);
  });

  it('round-trips a locked state', () => {
    const parsed = AdminUserActionStateSnapshotSchema.safeParse(lockedState);
    expect(parsed.success).toBe(true);
  });

  it('rejects negative failedLoginCount', () => {
    const parsed = AdminUserActionStateSnapshotSchema.safeParse({
      ...cleanState,
      failedLoginCount: -1,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown status', () => {
    const parsed = AdminUserActionStateSnapshotSchema.safeParse({
      ...cleanState,
      status: 'archived',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const parsed = AdminUserActionStateSnapshotSchema.safeParse({
      ...cleanState,
      flag: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('AdminUserActionResponseSchema', () => {
  const suspendResponse: AdminUserActionResponse = {
    user: sampleSummary,
    action: 'suspend',
    performedAt: NOW_ISO,
    performedByUserId: 'admin_1',
    before: { ...cleanState, status: 'active' },
    after: { ...cleanState, status: 'suspended' },
    reason: 'trust_safety',
    note: null,
  };

  it('round-trips a suspend response', () => {
    const parsed = AdminUserActionResponseSchema.safeParse(suspendResponse);
    expect(parsed.success).toBe(true);
  });

  it('round-trips a reinstate response', () => {
    const parsed = AdminUserActionResponseSchema.safeParse({
      ...suspendResponse,
      action: 'reinstate',
      before: { ...cleanState, status: 'suspended' },
      after: { ...cleanState, status: 'active' },
      reason: 'user_request',
      note: 'spoke with primary contact 2026-05-18',
    });
    expect(parsed.success).toBe(true);
  });

  it('round-trips an unlock response (no reason)', () => {
    const parsed = AdminUserActionResponseSchema.safeParse({
      ...suspendResponse,
      action: 'unlock',
      before: lockedState,
      after: {
        ...lockedState,
        failedLoginCount: 0,
        lastFailedLoginAt: null,
        lockedUntil: null,
        currentlyLocked: false,
      },
      reason: null,
      note: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown action discriminator', () => {
    const parsed = AdminUserActionResponseSchema.safeParse({
      ...suspendResponse,
      action: 'delete',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const parsed = AdminUserActionResponseSchema.safeParse({
      ...suspendResponse,
      auditEventId: 'evt_1',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects mismatched reason value', () => {
    const parsed = AdminUserActionResponseSchema.safeParse({
      ...suspendResponse,
      reason: 'invalid_reason',
    });
    expect(parsed.success).toBe(false);
  });
});
