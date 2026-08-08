import { describe, expect, it } from 'vitest';

import {
  GLOBAL_SCOPE,
  hasPermission,
  PermissionDeniedError,
  requirePermission,
  type RequestContext,
  type RoleAssignment,
  type TenantScope,
} from '../index';

const NOW = new Date('2026-05-07T12:00:00.000Z');

const tenantA: TenantScope = { type: 'tenant', tenantId: 'tenant_a' };
const tenantB: TenantScope = { type: 'tenant', tenantId: 'tenant_b' };
const householdX: TenantScope = { type: 'household', householdId: 'hh_x' };
const householdY: TenantScope = { type: 'household', householdId: 'hh_y' };

const buildContext = (
  roles: readonly RoleAssignment[],
  tenantScope: TenantScope = GLOBAL_SCOPE,
): RequestContext => ({
  userId: 'user_1',
  mfaVerified: true,
  roles,
  tenantScope,
});

describe('hasPermission — happy paths', () => {
  it('grants when a global role includes the permission', () => {
    const ctx = buildContext(
      [{ name: 'super_admin', scope: GLOBAL_SCOPE, permissions: ['user:read'] }],
      tenantA,
    );
    expect(hasPermission(ctx, 'user:read', { now: NOW })).toBe(true);
  });

  it('grants when a tenant-scoped role authorises the request scope', () => {
    const ctx = buildContext(
      [{ name: 'partner_admin', scope: tenantA, permissions: ['resident:read'] }],
      tenantA,
    );
    expect(hasPermission(ctx, 'resident:read', { now: NOW })).toBe(true);
  });

  it('grants when a household-scoped role authorises the request scope', () => {
    const ctx = buildContext(
      [{ name: 'family_payer', scope: householdX, permissions: ['booking:create'] }],
      householdX,
    );
    expect(hasPermission(ctx, 'booking:create', { now: NOW })).toBe(true);
  });

  it('honours an explicit `options.scope` override over the context scope', () => {
    const ctx = buildContext(
      [{ name: 'partner_admin', scope: tenantA, permissions: ['resident:read'] }],
      GLOBAL_SCOPE,
    );
    expect(hasPermission(ctx, 'resident:read', { now: NOW, scope: tenantA })).toBe(true);
  });
});

describe('hasPermission — denial paths', () => {
  it('denies when the user has no roles', () => {
    const ctx = buildContext([], tenantA);
    expect(hasPermission(ctx, 'user:read', { now: NOW })).toBe(false);
  });

  it('denies when the role has the wrong permission', () => {
    const ctx = buildContext(
      [{ name: 'family_observer', scope: householdX, permissions: ['booking:read'] }],
      householdX,
    );
    expect(hasPermission(ctx, 'booking:write', { now: NOW })).toBe(false);
  });

  it('denies a tenant-scoped role acting in a different tenant (out-of-scope)', () => {
    const ctx = buildContext(
      [{ name: 'partner_admin', scope: tenantA, permissions: ['resident:read'] }],
      tenantB,
    );
    expect(hasPermission(ctx, 'resident:read', { now: NOW })).toBe(false);
  });

  it('denies a household-scoped role acting in a different household (out-of-scope)', () => {
    const ctx = buildContext(
      [{ name: 'family_payer', scope: householdX, permissions: ['booking:create'] }],
      householdY,
    );
    expect(hasPermission(ctx, 'booking:create', { now: NOW })).toBe(false);
  });

  it('denies a tenant-scoped role on a household request (no implicit hierarchy)', () => {
    const ctx = buildContext(
      [{ name: 'partner_admin', scope: tenantA, permissions: ['booking:read'] }],
      householdX,
    );
    expect(hasPermission(ctx, 'booking:read', { now: NOW })).toBe(false);
  });
});

describe('hasPermission — role-assignment expiry (CLAUDE.md §3.2)', () => {
  it('denies when the role assignment has expired', () => {
    const expired: RoleAssignment = {
      name: 'finance',
      scope: GLOBAL_SCOPE,
      permissions: ['accounting:close_period'],
      expiresAt: '2026-05-07T11:59:59.000Z', // 1s before NOW
    };
    const ctx = buildContext([expired]);
    expect(hasPermission(ctx, 'accounting:close_period', { now: NOW })).toBe(false);
  });

  it('grants when the role assignment expires strictly in the future', () => {
    const stillActive: RoleAssignment = {
      name: 'finance',
      scope: GLOBAL_SCOPE,
      permissions: ['accounting:close_period'],
      expiresAt: '2026-05-07T12:00:00.001Z', // 1ms after NOW
    };
    const ctx = buildContext([stillActive]);
    expect(hasPermission(ctx, 'accounting:close_period', { now: NOW })).toBe(true);
  });

  it('denies when the role assignment expiry equals "now" (treats as expired, not active)', () => {
    const exactlyNow: RoleAssignment = {
      name: 'finance',
      scope: GLOBAL_SCOPE,
      permissions: ['accounting:close_period'],
      expiresAt: NOW.toISOString(),
    };
    const ctx = buildContext([exactlyNow]);
    expect(hasPermission(ctx, 'accounting:close_period', { now: NOW })).toBe(false);
  });

  it('denies fail-closed on an unparseable expiresAt', () => {
    const malformed: RoleAssignment = {
      name: 'finance',
      scope: GLOBAL_SCOPE,
      permissions: ['accounting:close_period'],
      expiresAt: 'not-a-real-date',
    };
    const ctx = buildContext([malformed]);
    expect(hasPermission(ctx, 'accounting:close_period', { now: NOW })).toBe(false);
  });

  it('still grants from a non-expired sibling assignment when one is expired', () => {
    const expired: RoleAssignment = {
      name: 'finance_temp',
      scope: GLOBAL_SCOPE,
      permissions: ['accounting:close_period'],
      expiresAt: '2026-05-07T11:00:00.000Z',
    };
    const stillActive: RoleAssignment = {
      name: 'finance',
      scope: GLOBAL_SCOPE,
      permissions: ['accounting:close_period'],
    };
    const ctx = buildContext([expired, stillActive]);
    expect(hasPermission(ctx, 'accounting:close_period', { now: NOW })).toBe(true);
  });
});

describe('requirePermission', () => {
  it('returns void when the user has the permission', () => {
    const ctx = buildContext([
      { name: 'super_admin', scope: GLOBAL_SCOPE, permissions: ['user:read'] },
    ]);
    expect(() => requirePermission(ctx, 'user:read', { now: NOW })).not.toThrow();
  });

  it('throws PermissionDeniedError carrying permission, scope, and userId', () => {
    const ctx = buildContext([], tenantA);
    let caught: unknown;
    try {
      requirePermission(ctx, 'user:read', { now: NOW });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PermissionDeniedError);
    const err = caught as PermissionDeniedError;
    expect(err.permission).toBe('user:read');
    expect(err.userId).toBe('user_1');
    expect(err.scope).toEqual(tenantA);
    expect(err.message).toContain('user:read');
    expect(err.message).toContain('tenant:tenant_a');
    expect(err.message).toContain('user_1');
  });
});
