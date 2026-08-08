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

import { AdminRoleApprovalsProxyController } from './admin-role-approvals-proxy.controller';

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
  headers: { 'x-trace-id': 'tr_test_294' },
} as unknown as RequestWithContext;

const APPROVAL = {
  id: 'apr_1',
  userId: 'user_1',
  roleName: 'finance',
  scope: { type: 'global' },
  expiresAt: null,
  requestedByUserId: 'usr_requester',
  reason: 'quarter close',
  status: 'pending',
  approvedByUserId: null,
  decidedAt: null,
  decisionNote: null,
  userRoleId: null,
  createdAt: NOW_ISO,
};

function okResult(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminRoleApprovalsProxyController list', () => {
  it('proxies the list and forwards the status filter only when set', async () => {
    const stub = new StubDownstreamClient(okResult({ approvals: [APPROVAL] }));
    const c = new AdminRoleApprovalsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.list({}, REQUEST_WITH_CTX);
    expect(response.approvals).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('identity');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/role-approvals');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_admin');

    await c.list({ status: 'pending' }, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/role-approvals?status=pending');
  });

  it('rejects an unknown status without calling the downstream', async () => {
    const stub = new StubDownstreamClient(okResult({ approvals: [] }));
    const c = new AdminRoleApprovalsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({ status: 'open' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(stub.calls).toBe(0);
  });

  it('502s when the downstream body does not conform to the contract', async () => {
    const stub = new StubDownstreamClient(okResult({ approvals: [{ nope: true }] }));
    const c = new AdminRoleApprovalsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('AdminRoleApprovalsProxyController mutations', () => {
  it('validates the request inbound (reason REQUIRED), forwards body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(okResult({ approval: APPROVAL }));
    const c = new AdminRoleApprovalsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.request(
      { userId: 'user_1', roleName: 'finance', scope: { type: 'global' }, reason: 'quarter close' },
      'idem_key_1',
      REQUEST_WITH_CTX,
    );
    expect(response.approval.id).toBe('apr_1');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/role-approvals');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_key_1');

    await expect(
      c.request(
        { userId: 'user_1', roleName: 'finance', scope: { type: 'global' } },
        'idem_key_2',
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('proxies approve and reject to the action paths with the decision body', async () => {
    const decided = {
      ...APPROVAL,
      status: 'approved',
      approvedByUserId: 'usr_admin',
      userRoleId: 'ur_9',
      decidedAt: NOW_ISO,
    };
    const stub = new StubDownstreamClient(okResult({ approval: decided }));
    const c = new AdminRoleApprovalsProxyController(stub as unknown as DownstreamHttpClient);

    await c.approve('apr_1', { note: 'ok' }, 'idem_a', REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/role-approvals/apr_1/approve');
    expect(stub.lastOptions?.body).toEqual({ note: 'ok' });
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_a');

    await c.reject('apr_1', undefined, 'idem_r', REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/role-approvals/apr_1/reject');
    expect(stub.lastOptions?.body).toEqual({});
  });

  it('rejects a decision body with unknown fields without calling the downstream', async () => {
    const stub = new StubDownstreamClient(okResult({ approval: APPROVAL }));
    const c = new AdminRoleApprovalsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.approve('apr_1', { approve: true }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.calls).toBe(0);
  });
});

describe('AdminRoleApprovalsProxyController permission gating', () => {
  function requiredPermissions(handler: object): unknown {
    return Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, handler);
  }

  it('gates the list on rbac:read and the mutations on rbac:write', () => {
    expect(
      requiredPermissions(AdminRoleApprovalsProxyController.prototype.list as unknown as object),
    ).toEqual(['rbac:read']);
    for (const handler of [
      AdminRoleApprovalsProxyController.prototype.request,
      AdminRoleApprovalsProxyController.prototype.approve,
      AdminRoleApprovalsProxyController.prototype.reject,
    ]) {
      expect(requiredPermissions(handler as unknown as object)).toEqual(['rbac:write']);
    }
  });
});
