import { describe, expect, it } from 'vitest';

import {
  ADMIN_USERS_LIST_LIMIT_DEFAULT,
  ADMIN_USERS_LIST_LIMIT_MAX,
  ADMIN_USERS_LIST_QUERY_MAX_LENGTH,
  AdminUserDetailResponseSchema,
  AdminUserDetailSchema,
  AdminUserSummarySchema,
  AdminUsersListQuerySchema,
  AdminUsersListResponseSchema,
  type AdminUserDetail,
  type AdminUserSummary,
} from '../http/admin-users.schema';

const NOW_ISO = '2026-05-17T12:00:00.000Z';

const sampleSummary: AdminUserSummary = {
  id: 'usr_abc',
  email: 'alice@example.com',
  phone: '+15551112222',
  status: 'active',
  mfaEnabled: true,
  emailVerifiedAt: NOW_ISO,
  activeRoleCount: 2,
  holdsAdminRole: false,
  currentlyLocked: false,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const sampleDetail: AdminUserDetail = {
  id: 'usr_abc',
  email: 'alice@example.com',
  phone: '+15551112222',
  status: 'active',
  mfaEnabled: true,
  emailVerifiedAt: NOW_ISO,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
  deletedAt: null,
  roles: [
    {
      name: 'family_payer',
      permissions: [],
      scope: { type: 'global' },
    },
  ],
  holdsAdminRole: false,
  mfaMethods: [
    {
      id: 'mfa_1',
      kind: 'totp',
      label: 'iPhone Authenticator',
      confirmedAt: NOW_ISO,
      lastUsedAt: NOW_ISO,
      createdAt: NOW_ISO,
    },
  ],
  latestKyc: {
    id: 'kyc_1',
    status: 'verified',
    verifiedAt: NOW_ISO,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  },
  lockout: {
    failedLoginCount: 0,
    lastFailedLoginAt: null,
    lockedUntil: null,
    currentlyLocked: false,
  },
};

describe('AdminUsersListQuerySchema', () => {
  it('returns a fully-defaulted parse when no filters supplied', () => {
    const parsed = AdminUsersListQuerySchema.parse({});
    expect(parsed.limit).toBe(ADMIN_USERS_LIST_LIMIT_DEFAULT);
    expect(parsed.q).toBeUndefined();
    expect(parsed.status).toBeUndefined();
    expect(parsed.roleName).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
  });

  it('coerces a numeric-string limit (URL query params arrive as strings)', () => {
    const parsed = AdminUsersListQuerySchema.parse({ limit: '50' });
    expect(parsed.limit).toBe(50);
  });

  it('rejects a limit above the bound', () => {
    expect(
      AdminUsersListQuerySchema.safeParse({ limit: ADMIN_USERS_LIST_LIMIT_MAX + 1 }).success,
    ).toBe(false);
  });

  it('rejects a non-positive limit', () => {
    expect(AdminUsersListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(AdminUsersListQuerySchema.safeParse({ limit: -3 }).success).toBe(false);
  });

  it('accepts every UserStatus enum value as the status filter', () => {
    for (const status of ['pending_verification', 'active', 'suspended', 'deactivated'] as const) {
      const parsed = AdminUsersListQuerySchema.parse({ status });
      expect(parsed.status).toBe(status);
    }
  });

  it('rejects an unknown status value', () => {
    expect(AdminUsersListQuerySchema.safeParse({ status: 'mystery' }).success).toBe(false);
  });

  it('accepts q at the documented max length', () => {
    const q = 'a'.repeat(ADMIN_USERS_LIST_QUERY_MAX_LENGTH);
    expect(AdminUsersListQuerySchema.safeParse({ q }).success).toBe(true);
  });

  it('rejects q above the documented max length', () => {
    const q = 'a'.repeat(ADMIN_USERS_LIST_QUERY_MAX_LENGTH + 1);
    expect(AdminUsersListQuerySchema.safeParse({ q }).success).toBe(false);
  });

  it('accepts an opaque cursor', () => {
    const parsed = AdminUsersListQuerySchema.parse({ cursor: 'opaque_token_xyz' });
    expect(parsed.cursor).toBe('opaque_token_xyz');
  });

  it('rejects unknown fields (strict)', () => {
    expect(AdminUsersListQuerySchema.safeParse({ smuggled: '1' }).success).toBe(false);
  });
});

describe('AdminUserSummarySchema', () => {
  it('accepts a well-formed summary row', () => {
    expect(AdminUserSummarySchema.safeParse(sampleSummary).success).toBe(true);
  });

  it('accepts a phone-less user', () => {
    const noPhone = { ...sampleSummary, phone: null };
    expect(AdminUserSummarySchema.safeParse(noPhone).success).toBe(true);
  });

  it('rejects a negative activeRoleCount', () => {
    expect(
      AdminUserSummarySchema.safeParse({ ...sampleSummary, activeRoleCount: -1 }).success,
    ).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(AdminUserSummarySchema.safeParse({ ...sampleSummary, status: 'mystery' }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields (strict)', () => {
    expect(AdminUserSummarySchema.safeParse({ ...sampleSummary, smuggled: true }).success).toBe(
      false,
    );
  });
});

describe('AdminUsersListResponseSchema', () => {
  it('accepts an empty list with null cursor', () => {
    expect(AdminUsersListResponseSchema.safeParse({ users: [], nextCursor: null }).success).toBe(
      true,
    );
  });

  it('accepts a populated list with a non-null cursor', () => {
    expect(
      AdminUsersListResponseSchema.safeParse({
        users: [sampleSummary],
        nextCursor: 'next_page_token',
      }).success,
    ).toBe(true);
  });

  it('rejects an invalid summary inside the array', () => {
    expect(
      AdminUsersListResponseSchema.safeParse({
        users: [{ ...sampleSummary, status: 'mystery' }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminUsersListResponseSchema.safeParse({
        users: [],
        nextCursor: null,
        smuggled: true,
      }).success,
    ).toBe(false);
  });
});

describe('AdminUserDetailSchema', () => {
  it('accepts a well-formed detail record', () => {
    expect(AdminUserDetailSchema.safeParse(sampleDetail).success).toBe(true);
  });

  it('accepts a deleted-at tombstone', () => {
    const deleted = { ...sampleDetail, deletedAt: NOW_ISO };
    expect(AdminUserDetailSchema.safeParse(deleted).success).toBe(true);
  });

  it('accepts a user with no KYC record', () => {
    expect(AdminUserDetailSchema.safeParse({ ...sampleDetail, latestKyc: null }).success).toBe(
      true,
    );
  });

  it('accepts a user with no MFA methods', () => {
    expect(AdminUserDetailSchema.safeParse({ ...sampleDetail, mfaMethods: [] }).success).toBe(true);
  });

  it('accepts a currently-locked lockout snapshot', () => {
    const locked = {
      ...sampleDetail,
      lockout: {
        failedLoginCount: 5,
        lastFailedLoginAt: NOW_ISO,
        lockedUntil: NOW_ISO,
        currentlyLocked: true,
      },
    };
    expect(AdminUserDetailSchema.safeParse(locked).success).toBe(true);
  });

  it('rejects an MFA method whose kind is unknown', () => {
    expect(
      AdminUserDetailSchema.safeParse({
        ...sampleDetail,
        mfaMethods: [{ ...sampleDetail.mfaMethods[0]!, kind: 'mystery' }],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(AdminUserDetailSchema.safeParse({ ...sampleDetail, smuggled: true }).success).toBe(
      false,
    );
  });
});

describe('AdminUserDetailResponseSchema', () => {
  it('accepts a well-formed response envelope', () => {
    expect(AdminUserDetailResponseSchema.safeParse({ user: sampleDetail }).success).toBe(true);
  });

  it('rejects a missing user field', () => {
    expect(AdminUserDetailResponseSchema.safeParse({}).success).toBe(false);
  });
});
