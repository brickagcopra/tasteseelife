import { describe, expect, it } from 'vitest';

import { formatScope, GLOBAL_SCOPE, scopeAllows, type TenantScope } from '../index';

describe('scopeAllows', () => {
  const tenantA: TenantScope = { type: 'tenant', tenantId: 'tenant_a' };
  const tenantB: TenantScope = { type: 'tenant', tenantId: 'tenant_b' };
  const householdX: TenantScope = { type: 'household', householdId: 'hh_x' };
  const householdY: TenantScope = { type: 'household', householdId: 'hh_y' };

  it('global role authorises any request scope', () => {
    expect(scopeAllows(GLOBAL_SCOPE, GLOBAL_SCOPE)).toBe(true);
    expect(scopeAllows(GLOBAL_SCOPE, tenantA)).toBe(true);
    expect(scopeAllows(GLOBAL_SCOPE, householdX)).toBe(true);
  });

  it('tenant-scoped role authorises matching tenant only', () => {
    expect(scopeAllows(tenantA, tenantA)).toBe(true);
    expect(scopeAllows(tenantA, tenantB)).toBe(false);
  });

  it('tenant-scoped role does NOT authorise a household request (flat matching)', () => {
    expect(scopeAllows(tenantA, householdX)).toBe(false);
  });

  it('tenant-scoped role does NOT authorise a global request', () => {
    expect(scopeAllows(tenantA, GLOBAL_SCOPE)).toBe(false);
  });

  it('household-scoped role authorises matching household only', () => {
    expect(scopeAllows(householdX, householdX)).toBe(true);
    expect(scopeAllows(householdX, householdY)).toBe(false);
  });

  it('household-scoped role does NOT authorise tenant or global requests', () => {
    expect(scopeAllows(householdX, tenantA)).toBe(false);
    expect(scopeAllows(householdX, GLOBAL_SCOPE)).toBe(false);
  });
});

describe('formatScope', () => {
  it('renders human-readable scope strings', () => {
    expect(formatScope({ type: 'global' })).toBe('global');
    expect(formatScope({ type: 'tenant', tenantId: 'tenant_a' })).toBe('tenant:tenant_a');
    expect(formatScope({ type: 'household', householdId: 'hh_x' })).toBe('household:hh_x');
  });
});
