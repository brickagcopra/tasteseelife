import 'reflect-metadata';

import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestContext, RoleAssignment } from '@taste-and-see/auth-sdk';
import { describe, expect, it } from 'vitest';

import { PermissionGuard } from './permission-guard';
import { REQUIRE_PERMISSIONS_METADATA_KEY } from './require-permissions.decorator';

function makeContext(args: {
  readonly metadata?: readonly string[];
  readonly request?: { requestContext?: RequestContext };
  readonly classMetadata?: readonly string[];
}): ExecutionContext {
  const reflectorTarget = {} as Record<symbol, unknown>;
  const handlerTarget = {} as Record<symbol, unknown>;
  if (args.metadata !== undefined) {
    Reflect.defineMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, args.metadata, handlerTarget);
  }
  if (args.classMetadata !== undefined) {
    Reflect.defineMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, args.classMetadata, reflectorTarget);
  }

  const ctx = {
    getHandler: () => handlerTarget,
    getClass: () => reflectorTarget,
    switchToHttp: () => ({
      getRequest: () => args.request ?? {},
    }),
  } as unknown as ExecutionContext;
  return ctx;
}

function ctxWithRoles(roles: readonly RoleAssignment[]): RequestContext {
  return {
    userId: 'user_1',
    mfaVerified: true,
    roles,
    tenantScope: { type: 'global' },
  };
}

const PROVIDER_OPS_ROLE: RoleAssignment = {
  name: 'provider_ops',
  scope: { type: 'global' },
  permissions: ['user:read', 'provider:approve'],
};

const CUSTOMER_SUPPORT_ROLE: RoleAssignment = {
  name: 'customer_support',
  scope: { type: 'global' },
  permissions: ['user:read'],
};

describe('PermissionGuard', () => {
  it('returns true with no metadata (no-op)', () => {
    const guard = new PermissionGuard(new Reflector());
    const ctx = makeContext({});
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('returns true with empty metadata array (no-op)', () => {
    const guard = new PermissionGuard(new Reflector());
    const ctx = makeContext({ metadata: [] });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws 401 when metadata is set but requestContext is missing', () => {
    const guard = new PermissionGuard(new Reflector());
    const ctx = makeContext({
      metadata: ['provider:approve'],
      request: {},
    });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('returns true when the user holds the required permission', () => {
    const guard = new PermissionGuard(new Reflector());
    const ctx = makeContext({
      metadata: ['provider:approve'],
      request: { requestContext: ctxWithRoles([PROVIDER_OPS_ROLE]) },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws 403 when the user holds no role with the permission', () => {
    const guard = new PermissionGuard(new Reflector());
    const ctx = makeContext({
      metadata: ['provider:approve'],
      request: { requestContext: ctxWithRoles([CUSTOMER_SUPPORT_ROLE]) },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('throws 403 when the user holds no roles at all', () => {
    const guard = new PermissionGuard(new Reflector());
    const ctx = makeContext({
      metadata: ['provider:approve'],
      request: { requestContext: ctxWithRoles([]) },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('requires ALL permissions when multiple are listed (AND semantics)', () => {
    const partialRole: RoleAssignment = {
      name: 'partial',
      scope: { type: 'global' },
      permissions: ['provider:approve'],
    };

    const guard = new PermissionGuard(new Reflector());
    const ctx = makeContext({
      metadata: ['provider:approve', 'finance:adjust'],
      request: { requestContext: ctxWithRoles([partialRole]) },
    });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('merges class-level and method-level metadata (both required)', () => {
    const role: RoleAssignment = {
      name: 'union',
      scope: { type: 'global' },
      permissions: ['provider:approve', 'user:suspend'],
    };

    const guard = new PermissionGuard(new Reflector());
    const ctx = makeContext({
      classMetadata: ['user:suspend'],
      metadata: ['provider:approve'],
      request: { requestContext: ctxWithRoles([role]) },
    });

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('honours expired role assignments by treating them as not active', () => {
    const expiredRole: RoleAssignment = {
      name: 'provider_ops',
      scope: { type: 'global' },
      permissions: ['provider:approve'],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };

    const guard = new PermissionGuard(new Reflector());
    const ctx = makeContext({
      metadata: ['provider:approve'],
      request: { requestContext: ctxWithRoles([expiredRole]) },
    });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
