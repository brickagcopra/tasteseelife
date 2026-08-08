import { describe, expect, it } from 'vitest';

import {
  ADMIN_ROLES_DESCRIPTION_MAX_LENGTH,
  ADMIN_ROLES_NAME_MAX_LENGTH,
  ADMIN_ROLES_PERMISSIONS_MAX,
  AdminPermissionRecordSchema,
  AdminPermissionsListResponseSchema,
  AdminRoleRecordSchema,
  AdminRoleResponseSchema,
  AdminRolesListQuerySchema,
  AdminRolesListResponseSchema,
  ArchiveAdminRoleRequestSchema,
  CreateAdminRoleRequestSchema,
  UpdateAdminRoleRequestSchema,
  type AdminRoleRecord,
} from '../http';

const NOW_ISO = '2026-07-01T12:00:00.000Z';

const sampleRole: AdminRoleRecord = {
  id: 'role_abc',
  name: 'regional_ops',
  description: 'Regional operations staff.',
  isSystem: false,
  archivedAt: null,
  permissions: ['user:read', 'concierge:read'],
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

describe('AdminPermissionRecordSchema', () => {
  it('accepts a catalog permission with a null description', () => {
    const parsed = AdminPermissionRecordSchema.safeParse({
      id: 'perm_1',
      resource: 'accounting',
      action: 'close_period',
      description: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    const parsed = AdminPermissionRecordSchema.safeParse({
      id: 'perm_1',
      resource: 'user',
      action: 'read',
      description: null,
      extra: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('AdminRoleRecordSchema', () => {
  it('accepts a live custom role', () => {
    expect(AdminRoleRecordSchema.safeParse(sampleRole).success).toBe(true);
  });

  it('accepts an archived system role', () => {
    const parsed = AdminRoleRecordSchema.safeParse({
      ...sampleRole,
      isSystem: true,
      archivedAt: NOW_ISO,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a role name that is not lower snake_case', () => {
    for (const name of ['RegionalOps', 'regional-ops', '1regional', 'regional ops']) {
      const parsed = AdminRoleRecordSchema.safeParse({ ...sampleRole, name });
      expect(parsed.success, `name=${name}`).toBe(false);
    }
  });

  it('rejects a malformed permission string', () => {
    for (const permission of ['userread', 'user:', ':read', 'User:Read']) {
      const parsed = AdminRoleRecordSchema.safeParse({
        ...sampleRole,
        permissions: [permission],
      });
      expect(parsed.success, `permission=${permission}`).toBe(false);
    }
  });
});

describe('AdminRolesListQuerySchema', () => {
  it('accepts an empty query', () => {
    expect(AdminRolesListQuerySchema.safeParse({}).success).toBe(true);
  });

  it('coerces includeArchived from the query string', () => {
    const parsed = AdminRolesListQuerySchema.safeParse({ includeArchived: 'true' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.includeArchived).toBe(true);
  });

  it('rejects unknown query params (strict)', () => {
    expect(AdminRolesListQuerySchema.safeParse({ limit: '10' }).success).toBe(false);
  });
});

describe('CreateAdminRoleRequestSchema', () => {
  it('accepts a minimal role (empty permission set is legal)', () => {
    const parsed = CreateAdminRoleRequestSchema.safeParse({
      name: 'regional_ops',
      permissions: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a full payload', () => {
    const parsed = CreateAdminRoleRequestSchema.safeParse({
      name: 'regional_ops',
      description: 'Regional operations staff.',
      permissions: ['user:read', 'concierge:read'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects duplicate permission strings', () => {
    const parsed = CreateAdminRoleRequestSchema.safeParse({
      name: 'regional_ops',
      permissions: ['user:read', 'user:read'],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a name past the length cap', () => {
    const parsed = CreateAdminRoleRequestSchema.safeParse({
      name: 'a'.repeat(ADMIN_ROLES_NAME_MAX_LENGTH + 1),
      permissions: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a permission set past the bound', () => {
    const permissions = Array.from(
      { length: ADMIN_ROLES_PERMISSIONS_MAX + 1 },
      (_, i) => `resource_${i}:read`,
    );
    const parsed = CreateAdminRoleRequestSchema.safeParse({
      name: 'regional_ops',
      permissions,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects isSystem on the wire (strict)', () => {
    const parsed = CreateAdminRoleRequestSchema.safeParse({
      name: 'regional_ops',
      permissions: [],
      isSystem: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('UpdateAdminRoleRequestSchema', () => {
  it('accepts a rename-only patch', () => {
    expect(UpdateAdminRoleRequestSchema.safeParse({ name: 'regional_leads' }).success).toBe(true);
  });

  it('accepts a description clear (explicit null)', () => {
    expect(UpdateAdminRoleRequestSchema.safeParse({ description: null }).success).toBe(true);
  });

  it('accepts a permission-set replacement', () => {
    const parsed = UpdateAdminRoleRequestSchema.safeParse({
      permissions: ['user:read'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty patch (at-least-one-field)', () => {
    expect(UpdateAdminRoleRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a description past the length cap', () => {
    const parsed = UpdateAdminRoleRequestSchema.safeParse({
      description: 'a'.repeat(ADMIN_ROLES_DESCRIPTION_MAX_LENGTH + 1),
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ArchiveAdminRoleRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(ArchiveAdminRoleRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts an audit note', () => {
    const parsed = ArchiveAdminRoleRequestSchema.safeParse({
      note: 'superseded by regional_leads',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty note', () => {
    expect(ArchiveAdminRoleRequestSchema.safeParse({ note: '' }).success).toBe(false);
  });
});

describe('response envelopes', () => {
  it('AdminRolesListResponse round-trips', () => {
    const parsed = AdminRolesListResponseSchema.safeParse({ roles: [sampleRole] });
    expect(parsed.success).toBe(true);
  });

  it('AdminRoleResponse round-trips', () => {
    const parsed = AdminRoleResponseSchema.safeParse({ role: sampleRole });
    expect(parsed.success).toBe(true);
  });

  it('AdminPermissionsListResponse round-trips', () => {
    const parsed = AdminPermissionsListResponseSchema.safeParse({
      permissions: [{ id: 'perm_1', resource: 'user', action: 'read', description: 'View users.' }],
    });
    expect(parsed.success).toBe(true);
  });
});
