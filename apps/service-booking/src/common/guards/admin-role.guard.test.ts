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
    sessionId: 'sess_1',
    mfaVerified: true,
    roles,
    tenantScope: { type: 'global' },
  };
}

describe('SuperAdminRoleGuard (service-booking)', () => {
  it('throws 401 when the upstream guard did not attach a RequestContext', async () => {
    const guard = new SuperAdminRoleGuard();
    const ctx = makeContext({});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws 403 when the caller holds no admin-staff role', async () => {
    const guard = new SuperAdminRoleGuard();
    const requestContext = buildCtx([
      { name: 'family_payer', permissions: [], scope: { type: 'global' } },
    ]);
    const ctx = makeContext({ requestContext });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws 403 when the caller holds an admin role but not super_admin', async () => {
    const guard = new SuperAdminRoleGuard();
    const requestContext = buildCtx([
      { name: 'trust_safety', permissions: [], scope: { type: 'global' } },
    ]);
    const ctx = makeContext({ requestContext });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows when the caller holds an active super_admin assignment', async () => {
    const guard = new SuperAdminRoleGuard();
    const requestContext = buildCtx([
      { name: 'super_admin', permissions: [], scope: { type: 'global' } },
    ]);
    const ctx = makeContext({ requestContext });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('throws 403 when the super_admin assignment has expired', async () => {
    const guard = new SuperAdminRoleGuard();
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    const requestContext = buildCtx([
      {
        name: 'super_admin',
        permissions: [],
        scope: { type: 'global' },
        expiresAt: pastIso,
      },
    ]);
    const ctx = makeContext({ requestContext });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows when the super_admin assignment has a future expiry', async () => {
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
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
