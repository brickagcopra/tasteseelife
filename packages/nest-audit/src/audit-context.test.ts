import type { RequestContext, RoleAssignment, TenantScope } from '@taste-and-see/auth-sdk';
import { describe, expect, it } from 'vitest';

import { buildAuditActorContext, type AuditRequestLike } from './audit-context';

function role(name: string): RoleAssignment {
  return { name, scope: { type: 'global' }, permissions: [] };
}

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: 'admin_1',
    mfaVerified: true,
    roles: [role('marketing')],
    tenantScope: { type: 'global' },
    ...overrides,
  };
}

function request(overrides: Partial<AuditRequestLike> = {}): AuditRequestLike {
  return { ip: '203.0.113.5', headers: {}, ...overrides };
}

describe('buildAuditActorContext', () => {
  it('stamps the actor id + the admin role + global scope', () => {
    const result = buildAuditActorContext(ctx(), request());
    expect(result.actorUserId).toBe('admin_1');
    expect(result.actorRole).toBe('marketing');
    expect(result.actorTenantScopeType).toBe('global');
    expect(result.actorTenantScopeId).toBeNull();
  });

  it('prefers an admin-staff role over a customer-facing one', () => {
    const result = buildAuditActorContext(
      ctx({ roles: [role('family_observer'), role('marketing')] }),
      request(),
    );
    expect(result.actorRole).toBe('marketing');
  });

  it('falls back to the first role when no admin role is present', () => {
    const result = buildAuditActorContext(ctx({ roles: [role('family_payer')] }), request());
    expect(result.actorRole).toBe('family_payer');
  });

  it('returns a null role when there are no roles', () => {
    const result = buildAuditActorContext(ctx({ roles: [] }), request());
    expect(result.actorRole).toBeNull();
  });

  it('maps a tenant scope onto type + id', () => {
    const scope: TenantScope = { type: 'tenant', tenantId: 'partner_9' };
    const result = buildAuditActorContext(ctx({ tenantScope: scope }), request());
    expect(result.actorTenantScopeType).toBe('tenant');
    expect(result.actorTenantScopeId).toBe('partner_9');
  });

  it('maps a household scope onto type + id', () => {
    const scope: TenantScope = { type: 'household', householdId: 'hh_2' };
    const result = buildAuditActorContext(ctx({ tenantScope: scope }), request());
    expect(result.actorTenantScopeType).toBe('household');
    expect(result.actorTenantScopeId).toBe('hh_2');
  });

  it('extracts ip / user-agent / request-id from the request', () => {
    const result = buildAuditActorContext(
      ctx(),
      request({ ip: '198.51.100.7', headers: { 'user-agent': 'UA', 'x-request-id': 'req_42' } }),
    );
    expect(result.ip).toBe('198.51.100.7');
    expect(result.userAgent).toBe('UA');
    expect(result.requestId).toBe('req_42');
  });

  it('takes the first value of a multi-valued header', () => {
    const result = buildAuditActorContext(
      ctx(),
      request({ headers: { 'user-agent': ['A', 'B'] } }),
    );
    expect(result.userAgent).toBe('A');
  });

  it('nulls out a blank ip / absent headers', () => {
    const result = buildAuditActorContext(ctx(), { ip: '   ', headers: {} });
    expect(result.ip).toBeNull();
    expect(result.userAgent).toBeNull();
    expect(result.requestId).toBeNull();
    expect(result.traceId).toBeNull();
  });

  it('parses the trace id from a W3C traceparent header', () => {
    const traceId = 'abcdef0123456789abcdef0123456789';
    const result = buildAuditActorContext(
      ctx(),
      request({ headers: { traceparent: `00-${traceId}-0123456789abcdef-01` } }),
    );
    expect(result.traceId).toBe(traceId);
  });

  it('nulls a malformed traceparent', () => {
    const result = buildAuditActorContext(ctx(), request({ headers: { traceparent: 'garbage' } }));
    expect(result.traceId).toBeNull();
  });
});
