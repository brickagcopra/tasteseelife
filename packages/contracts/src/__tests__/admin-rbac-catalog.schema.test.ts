import { describe, expect, it } from 'vitest';

import {
  AdminRbacCatalogExportResponseSchema,
  RBAC_CATALOG_FORMAT_VERSION,
  RbacCatalogEnvelopeSchema,
  RbacCatalogPermissionSchema,
  RbacCatalogRoleSchema,
} from '../http/admin-rbac-catalog.schema';

const VALID_PERMISSION = {
  resource: 'rbac',
  action: 'read',
  description: 'Read the RBAC catalog.',
};

const VALID_ROLE = {
  name: 'read_only_auditor',
  description: 'Auditor / external reviewer.',
  isSystem: true,
  permissions: ['audit:read', 'rbac:read', 'user:read'],
};

const VALID_ENVELOPE = {
  formatVersion: RBAC_CATALOG_FORMAT_VERSION,
  exportedAt: '2026-07-02T12:00:00.000Z',
  permissions: [VALID_PERMISSION, { resource: 'audit', action: 'read', description: null }],
  roles: [VALID_ROLE],
};

describe('RbacCatalogPermissionSchema', () => {
  it('accepts a permission with a null description', () => {
    expect(
      RbacCatalogPermissionSchema.safeParse({ ...VALID_PERMISSION, description: null }).success,
    ).toBe(true);
  });

  it('rejects unknown fields (strict) and surrogate ids', () => {
    expect(RbacCatalogPermissionSchema.safeParse({ ...VALID_PERMISSION, id: 'p_1' }).success).toBe(
      false,
    );
  });
});

describe('RbacCatalogRoleSchema', () => {
  it('accepts a system role with sorted permission strings', () => {
    expect(RbacCatalogRoleSchema.safeParse(VALID_ROLE).success).toBe(true);
  });

  it('rejects duplicate permission strings', () => {
    expect(
      RbacCatalogRoleSchema.safeParse({
        ...VALID_ROLE,
        permissions: ['audit:read', 'audit:read'],
      }).success,
    ).toBe(false);
  });

  it('rejects malformed permission strings and role names', () => {
    expect(
      RbacCatalogRoleSchema.safeParse({ ...VALID_ROLE, permissions: ['not-a-permission'] }).success,
    ).toBe(false);
    expect(RbacCatalogRoleSchema.safeParse({ ...VALID_ROLE, name: 'Bad Name' }).success).toBe(
      false,
    );
  });

  it('has no archivedAt — archive state is env-local, not catalog definition', () => {
    expect(RbacCatalogRoleSchema.safeParse({ ...VALID_ROLE, archivedAt: null }).success).toBe(
      false,
    );
  });
});

describe('RbacCatalogEnvelopeSchema', () => {
  it('accepts a valid envelope', () => {
    expect(RbacCatalogEnvelopeSchema.safeParse(VALID_ENVELOPE).success).toBe(true);
  });

  it('rejects any other formatVersion (literal pin)', () => {
    expect(
      RbacCatalogEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, formatVersion: 2 }).success,
    ).toBe(false);
  });

  it('rejects duplicate role names within one envelope', () => {
    expect(
      RbacCatalogEnvelopeSchema.safeParse({
        ...VALID_ENVELOPE,
        roles: [VALID_ROLE, VALID_ROLE],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate (resource, action) pairs within one envelope', () => {
    expect(
      RbacCatalogEnvelopeSchema.safeParse({
        ...VALID_ENVELOPE,
        permissions: [VALID_PERMISSION, VALID_PERMISSION],
      }).success,
    ).toBe(false);
  });

  it('rejects non-ISO exportedAt and unknown fields', () => {
    expect(
      RbacCatalogEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, exportedAt: 'yesterday' }).success,
    ).toBe(false);
    expect(RbacCatalogEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, extra: true }).success).toBe(
      false,
    );
  });

  it('is the export response schema verbatim (body IS the importable file)', () => {
    expect(AdminRbacCatalogExportResponseSchema).toBe(RbacCatalogEnvelopeSchema);
  });
});
