import { describe, expect, it } from 'vitest';

import {
  ADMIN_ROLE_NAMES,
  GLOBAL_SCOPE,
  SYSTEM_ROLE_NAMES,
  holdsAdminRole,
  isAdminRoleName,
  type RoleAssignment,
} from '../index';

const NOW = new Date('2026-05-09T12:00:00.000Z');

const buildRole = (
  name: string,
  overrides: { permissions?: readonly string[]; expiresAt?: string } = {},
): RoleAssignment => ({
  name,
  scope: GLOBAL_SCOPE,
  permissions: overrides.permissions ?? [],
  ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
});

describe('ADMIN_ROLE_NAMES', () => {
  it('matches the 10 admin staff roles enumerated in PDD §10.2', () => {
    expect([...ADMIN_ROLE_NAMES].sort()).toEqual(
      [
        'super_admin',
        'operations_manager',
        'customer_support',
        'concierge_lead',
        'provider_ops',
        'finance',
        'marketing',
        'content_editor',
        'trust_safety',
        'read_only_auditor',
      ].sort(),
    );
  });

  it('every admin role name is also a system role name (no drift)', () => {
    const systemSet = new Set<string>(SYSTEM_ROLE_NAMES);
    for (const name of ADMIN_ROLE_NAMES) {
      expect(systemSet.has(name)).toBe(true);
    }
  });

  it('customer-facing roles are NOT admin', () => {
    for (const name of [
      'family_payer',
      'family_observer',
      'senior_user',
      'provider',
      'partner_admin',
      'partner_member',
      'student',
    ]) {
      expect(isAdminRoleName(name)).toBe(false);
    }
  });
});

describe('isAdminRoleName', () => {
  it('returns true for every admin role name', () => {
    for (const name of ADMIN_ROLE_NAMES) {
      expect(isAdminRoleName(name)).toBe(true);
    }
  });

  it('returns false for unknown role names (custom roles, typos)', () => {
    expect(isAdminRoleName('superadmin')).toBe(false);
    expect(isAdminRoleName('SUPER_ADMIN')).toBe(false);
    expect(isAdminRoleName('custom_role_xyz')).toBe(false);
    expect(isAdminRoleName('')).toBe(false);
  });

  it('narrows the type to AdminRoleName', () => {
    const name: string = 'finance';
    if (isAdminRoleName(name)) {
      const adminName: 'super_admin' | 'finance' | (string & {}) = name;
      void adminName;
    }
    expect(true).toBe(true);
  });
});

describe('holdsAdminRole', () => {
  it('returns false for an empty role list', () => {
    expect(holdsAdminRole([], NOW)).toBe(false);
  });

  it('returns false when the user only holds customer-facing roles', () => {
    const roles = [buildRole('family_payer'), buildRole('senior_user')];
    expect(holdsAdminRole(roles, NOW)).toBe(false);
  });

  it('returns true when the user holds any admin role', () => {
    expect(holdsAdminRole([buildRole('finance')], NOW)).toBe(true);
    expect(holdsAdminRole([buildRole('super_admin')], NOW)).toBe(true);
    expect(holdsAdminRole([buildRole('read_only_auditor')], NOW)).toBe(true);
  });

  it('returns true when an admin role is mixed with customer-facing roles', () => {
    const roles = [buildRole('family_payer'), buildRole('finance'), buildRole('senior_user')];
    expect(holdsAdminRole(roles, NOW)).toBe(true);
  });

  it('ignores expired admin assignments', () => {
    const roles = [buildRole('finance', { expiresAt: '2026-01-01T00:00:00.000Z' })];
    expect(holdsAdminRole(roles, NOW)).toBe(false);
  });

  it('returns true for an admin assignment that is still in its expiry window', () => {
    const roles = [buildRole('finance', { expiresAt: '2026-12-31T00:00:00.000Z' })];
    expect(holdsAdminRole(roles, NOW)).toBe(true);
  });

  it('returns false when the only admin role has an unparseable expiresAt', () => {
    const roles = [buildRole('finance', { expiresAt: 'not-a-date' })];
    expect(holdsAdminRole(roles, NOW)).toBe(false);
  });

  it('defaults the now argument to the current time when omitted', () => {
    expect(holdsAdminRole([buildRole('finance')])).toBe(true);
    expect(holdsAdminRole([buildRole('finance', { expiresAt: '1999-01-01T00:00:00.000Z' })])).toBe(
      false,
    );
  });
});
