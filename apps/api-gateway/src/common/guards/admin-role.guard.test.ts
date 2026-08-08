import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import { SuperAdminRoleGuard } from './admin-role.guard';

function makeContext(request: Partial<RequestWithContext>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => request as T,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

function buildCtx(roles: RequestContext['roles']): RequestContext {
  return {
    userId: 'usr_1',
    sessionId: 'fam_1',
    mfaVerified: true,
    roles,
    tenantScope: { type: 'global' },
  };
}

describe('SuperAdminRoleGuard (api-gateway)', () => {
  it('throws 401 when the upstream guard did not attach a RequestContext', () => {
    const guard = new SuperAdminRoleGuard();
    const ctx = makeContext({});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws 403 when the caller holds no admin-staff role', () => {
    const guard = new SuperAdminRoleGuard();
    const requestContext = buildCtx([
      { name: 'family_payer', permissions: [], scope: { type: 'global' } },
    ]);
    const ctx = makeContext({ requestContext });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('throws 403 when the caller holds an admin role but not super_admin', () => {
    const guard = new SuperAdminRoleGuard();
    const requestContext = buildCtx([
      { name: 'finance', permissions: ['accounting:close_period'], scope: { type: 'global' } },
    ]);
    const ctx = makeContext({ requestContext });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('allows when the caller holds an active super_admin assignment', () => {
    const guard = new SuperAdminRoleGuard();
    const requestContext = buildCtx([
      { name: 'super_admin', permissions: [], scope: { type: 'global' } },
    ]);
    const ctx = makeContext({ requestContext });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects an expired super_admin assignment', () => {
    const guard = new SuperAdminRoleGuard();
    const expiredIso = new Date(Date.now() - 60_000).toISOString();
    const requestContext = buildCtx([
      {
        name: 'super_admin',
        permissions: [],
        scope: { type: 'global' },
        expiresAt: expiredIso,
      },
    ]);
    const ctx = makeContext({ requestContext });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('accepts a future-expiring super_admin assignment', () => {
    const guard = new SuperAdminRoleGuard();
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    const requestContext = buildCtx([
      {
        name: 'super_admin',
        permissions: [],
        scope: { type: 'global' },
        expiresAt: futureIso,
      },
    ]);
    const ctx = makeContext({ requestContext });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
