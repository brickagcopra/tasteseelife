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

import { AdminRoleAssignmentsProxyController } from './admin-role-assignments-proxy.controller';

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
  headers: { 'x-trace-id': 'tr_test_292' },
} as unknown as RequestWithContext;

const ASSIGNMENT = {
  id: 'ur_1',
  userId: 'user_1',
  roleName: 'customer_support',
  scope: { type: 'global' },
  active: true,
  grantedByUserId: 'usr_admin',
  expiresAt: null,
  revokedAt: null,
  createdAt: NOW_ISO,
};

const ROW = {
  userId: 'user_1',
  roleName: 'customer_support',
  scopeType: 'global',
  scopeId: null,
  expiresAt: null,
};

function okResult(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminRoleAssignmentsProxyController list', () => {
  it('proxies the per-user list and forwards includeInactive only when set', async () => {
    const stub = new StubDownstreamClient(okResult({ assignments: [ASSIGNMENT] }));
    const c = new AdminRoleAssignmentsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.listForUser('user_1', {}, REQUEST_WITH_CTX);
    expect(response.assignments).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('identity');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/users/user_1/role-assignments');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_admin');

    await c.listForUser('user_1', { includeInactive: 'true' }, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe(
      '/api/v1/admin/users/user_1/role-assignments?includeInactive=true',
    );
  });

  it('rejects an unknown query param without calling the downstream', async () => {
    const stub = new StubDownstreamClient(okResult({ assignments: [] }));
    const c = new AdminRoleAssignmentsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.listForUser('user_1', { limit: '10' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(stub.calls).toBe(0);
  });

  it('502s when the downstream body does not conform to the contract', async () => {
    const stub = new StubDownstreamClient(okResult({ assignments: [{ nope: true }] }));
    const c = new AdminRoleAssignmentsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.listForUser('user_1', {}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

describe('AdminRoleAssignmentsProxyController mutations', () => {
  it('validates the grant inbound, forwards body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(okResult({ assignment: ASSIGNMENT }));
    const c = new AdminRoleAssignmentsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.grant(
      { userId: 'user_1', roleName: 'customer_support', scope: { type: 'global' } },
      'idem_key_1',
      REQUEST_WITH_CTX,
    );

    expect(response.assignment.id).toBe('ur_1');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/role-assignments');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_key_1');
  });

  it('rejects an invalid grant payload without calling the downstream', async () => {
    const stub = new StubDownstreamClient(okResult({ assignment: ASSIGNMENT }));
    const c = new AdminRoleAssignmentsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.grant(
        // Tenant scope without its id fails the discriminated union.
        { userId: 'user_1', roleName: 'customer_support', scope: { type: 'tenant' } },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.calls).toBe(0);
  });

  it('proxies revoke with an empty body defaulted to {} and forwards the key', async () => {
    const stub = new StubDownstreamClient(okResult({ revoked: true }));
    const c = new AdminRoleAssignmentsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.revoke('ur_1', undefined, 'idem_key_2', REQUEST_WITH_CTX);
    expect(response.revoked).toBe(true);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/role-assignments/ur_1/revoke');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_key_2');
  });
});

describe('AdminRoleAssignmentsProxyController bulk', () => {
  it('proxies bulk-preview without an idempotency key (read-only)', async () => {
    const stub = new StubDownstreamClient(okResult({ verdicts: [], okCount: 0, errorCount: 0 }));
    const c = new AdminRoleAssignmentsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.bulkPreview({ rows: [ROW] }, REQUEST_WITH_CTX);
    expect(response.okCount).toBe(0);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/role-assignments/bulk-preview');
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });

  it('proxies bulk-commit and forwards the Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(
      okResult({
        outcomes: [{ index: 0, status: 'granted', assignmentId: 'ur_1', message: null }],
        grantedCount: 1,
        conflictCount: 0,
        errorCount: 0,
      }),
    );
    const c = new AdminRoleAssignmentsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.bulkCommit({ rows: [ROW] }, 'idem_key_3', REQUEST_WITH_CTX);
    expect(response.grantedCount).toBe(1);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/role-assignments/bulk-commit');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_key_3');
  });

  it('rejects an empty bulk batch without calling the downstream', async () => {
    const stub = new StubDownstreamClient(okResult({ verdicts: [], okCount: 0, errorCount: 0 }));
    const c = new AdminRoleAssignmentsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.bulkPreview({ rows: [] }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(stub.calls).toBe(0);
  });
});

describe('AdminRoleAssignmentsProxyController permission gating', () => {
  function requiredPermissions(handler: object): unknown {
    return Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, handler);
  }

  it('gates list + bulk-preview on rbac:read and mutations on rbac:write', () => {
    expect(
      requiredPermissions(
        AdminRoleAssignmentsProxyController.prototype.listForUser as unknown as object,
      ),
    ).toEqual(['rbac:read']);
    expect(
      requiredPermissions(
        AdminRoleAssignmentsProxyController.prototype.bulkPreview as unknown as object,
      ),
    ).toEqual(['rbac:read']);
    for (const handler of [
      AdminRoleAssignmentsProxyController.prototype.grant,
      AdminRoleAssignmentsProxyController.prototype.revoke,
      AdminRoleAssignmentsProxyController.prototype.bulkCommit,
    ]) {
      expect(requiredPermissions(handler as unknown as object)).toEqual(['rbac:write']);
    }
  });
});
