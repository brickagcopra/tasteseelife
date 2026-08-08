import 'reflect-metadata';

import { BadGatewayException, HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { REQUIRE_PERMISSIONS_METADATA_KEY } from '@taste-and-see/nest-auth';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { AdminRolesProxyController } from './admin-roles-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  public calls = 0;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    this.calls += 1;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW_ISO = '2026-07-01T12:00:00.000Z';

const REQUEST_WITH_CTX: RequestWithContext = {
  requestContext: {
    userId: 'usr_admin',
    mfaVerified: true,
    roles: [
      {
        name: 'super_admin',
        permissions: ['rbac:read', 'rbac:write'],
        scope: { type: 'global' },
      },
    ],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_290' },
} as unknown as RequestWithContext;

const VALID_ROLE = {
  id: 'role_1',
  name: 'regional_ops',
  description: 'Regional ops staff.',
  isSystem: false,
  archivedAt: null,
  permissions: ['user:read'],
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

function okResult(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminRolesProxyController reads', () => {
  it('proxies the permission catalog and forwards the actor', async () => {
    const stub = new StubDownstreamClient(
      okResult({
        permissions: [{ id: 'p1', resource: 'user', action: 'read', description: 'View users.' }],
      }),
    );
    const c = new AdminRolesProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.listPermissions(REQUEST_WITH_CTX);
    expect(response.permissions).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('identity');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/permissions');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_admin');
  });

  it('proxies the roles list and forwards includeArchived only when set', async () => {
    const stub = new StubDownstreamClient(okResult({ roles: [VALID_ROLE] }));
    const c = new AdminRolesProxyController(stub as unknown as DownstreamHttpClient);

    await c.listRoles({}, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/roles');

    await c.listRoles({ includeArchived: 'true' }, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/roles?includeArchived=true');
  });

  it('rejects an unknown query param without calling the downstream', async () => {
    const stub = new StubDownstreamClient(okResult({ roles: [] }));
    const c = new AdminRolesProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.listRoles({ limit: '10' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(stub.calls).toBe(0);
  });

  it('502s when the downstream body does not conform to the contract', async () => {
    const stub = new StubDownstreamClient(okResult({ roles: [{ nope: true }] }));
    const c = new AdminRolesProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.listRoles({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('forwards a downstream 404 verbatim on detail', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', status: 404, detail: 'Role missing.' },
      setCookies: [],
    });
    const c = new AdminRolesProxyController(stub as unknown as DownstreamHttpClient);

    const attempt = c.getRole('role_missing', REQUEST_WITH_CTX);
    await expect(attempt).rejects.toBeInstanceOf(HttpException);
    await attempt.catch((err: HttpException) => expect(err.getStatus()).toBe(404));
  });
});

describe('AdminRolesProxyController mutations', () => {
  it('validates create inbound, forwards body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(okResult({ role: VALID_ROLE }));
    const c = new AdminRolesProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.createRole(
      { name: 'regional_ops', permissions: ['user:read'] },
      'idem_key_1',
      REQUEST_WITH_CTX,
    );

    expect(response.role.name).toBe('regional_ops');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/roles');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_key_1');
  });

  it('rejects an invalid create payload without calling the downstream', async () => {
    const stub = new StubDownstreamClient(okResult({ role: VALID_ROLE }));
    const c = new AdminRolesProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.createRole({ name: 'Bad Name!', permissions: [] }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.calls).toBe(0);
  });

  it('rejects an empty update patch without calling the downstream', async () => {
    const stub = new StubDownstreamClient(okResult({ role: VALID_ROLE }));
    const c = new AdminRolesProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.updateRole('role_1', {}, undefined, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(stub.calls).toBe(0);
  });

  it('proxies archive with an empty body defaulted to {}', async () => {
    const stub = new StubDownstreamClient(
      okResult({ role: { ...VALID_ROLE, archivedAt: NOW_ISO } }),
    );
    const c = new AdminRolesProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.archiveRole('role_1', undefined, 'idem_key_2', REQUEST_WITH_CTX);
    expect(response.role.archivedAt).toBe(NOW_ISO);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/roles/role_1/archive');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_key_2');
  });
});

describe('AdminRolesProxyController permission gating', () => {
  function requiredPermissions(handler: object): unknown {
    return Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, handler);
  }

  it('gates reads on rbac:read and mutations on rbac:write', () => {
    expect(
      requiredPermissions(AdminRolesProxyController.prototype.listPermissions as unknown as object),
    ).toEqual(['rbac:read']);
    expect(
      requiredPermissions(AdminRolesProxyController.prototype.listRoles as unknown as object),
    ).toEqual(['rbac:read']);
    expect(
      requiredPermissions(AdminRolesProxyController.prototype.getRole as unknown as object),
    ).toEqual(['rbac:read']);
    expect(
      requiredPermissions(AdminRolesProxyController.prototype.createRole as unknown as object),
    ).toEqual(['rbac:write']);
    expect(
      requiredPermissions(AdminRolesProxyController.prototype.updateRole as unknown as object),
    ).toEqual(['rbac:write']);
    expect(
      requiredPermissions(AdminRolesProxyController.prototype.archiveRole as unknown as object),
    ).toEqual(['rbac:write']);
  });
});
