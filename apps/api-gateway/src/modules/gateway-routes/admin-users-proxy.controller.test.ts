import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { AdminUsersProxyController } from './admin-users-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW_ISO = '2026-05-17T12:00:00.000Z';

const REQUEST_WITH_CTX: RequestWithContext = {
  requestContext: {
    userId: 'usr_admin',
    mfaVerified: true,
    roles: [{ name: 'super_admin', permissions: [], scope: { type: 'global' } }],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_001' },
} as unknown as RequestWithContext;

const VALID_LIST_RESPONSE = {
  users: [
    {
      id: 'usr_1',
      email: 'alice@example.com',
      phone: '+15551112222',
      status: 'active' as const,
      mfaEnabled: true,
      emailVerifiedAt: NOW_ISO,
      activeRoleCount: 2,
      holdsAdminRole: false,
      currentlyLocked: false,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  ],
  nextCursor: 'opaque_cursor',
};

const VALID_DETAIL_RESPONSE = {
  user: {
    id: 'usr_1',
    email: 'alice@example.com',
    phone: '+15551112222',
    status: 'active' as const,
    mfaEnabled: true,
    emailVerifiedAt: NOW_ISO,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    deletedAt: null,
    roles: [
      {
        name: 'family_payer',
        permissions: [],
        scope: { type: 'global' as const },
      },
    ],
    holdsAdminRole: false,
    mfaMethods: [],
    latestKyc: null,
    lockout: {
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
      currentlyLocked: false,
    },
  },
};

describe('AdminUsersProxyController.list', () => {
  it('returns the response and forwards the actor', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.list({ limit: '25' }, REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_LIST_RESPONSE);
    expect(stub.lastOptions?.service).toBe('identity');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/users?limit=25');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_admin');
  });

  it('forwards every allow-listed filter to the downstream path', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await c.list(
      { q: 'alice', status: 'suspended', roleName: 'finance', cursor: 'cur_abc', limit: '50' },
      REQUEST_WITH_CTX,
    );
    const path = stub.lastOptions?.path ?? '';
    expect(path).toContain('q=alice');
    expect(path).toContain('status=suspended');
    expect(path).toContain('roleName=finance');
    expect(path).toContain('cursor=cur_abc');
    expect(path).toContain('limit=50');
  });

  it('rejects a malformed query (strict — unknown field) with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({ smuggled: '1' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects an unknown status filter with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({ status: 'mystery' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('throws 401 when no requestContext is attached (defence-in-depth)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.list({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('translates downstream timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('translates downstream network_error to 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'connection refused' });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('translates downstream server_error to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 503,
      body: null,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('translates not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'identity' });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('forwards a downstream 4xx verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Some downstream forbid.',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 403,
      body: downstreamBody,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toMatchObject({
      status: 403,
      response: downstreamBody,
    });
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { totally: 'wrong' },
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('AdminUsersProxyController.getById', () => {
  it('forwards the encoded id and returns the response', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DETAIL_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.getById('usr_1', REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_DETAIL_RESPONSE);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/users/usr_1');
  });

  it('URL-encodes the id to defeat path injection', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DETAIL_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await c.getById('usr/../admin', REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/users/usr%2F..%2Fadmin');
  });

  it('forwards a downstream 404 verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'User usr_missing not found.',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: downstreamBody,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.getById('usr_missing', REQUEST_WITH_CTX)).rejects.toMatchObject({
      status: 404,
      response: downstreamBody,
    });
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DETAIL_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.getById('usr_1', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { user: { totally: 'wrong' } },
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.getById('usr_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });
});

const VALID_SUSPEND_RESPONSE = {
  user: {
    id: 'usr_1',
    email: 'alice@example.com',
    phone: null,
    status: 'suspended' as const,
    mfaEnabled: false,
    emailVerifiedAt: null,
    activeRoleCount: 1,
    holdsAdminRole: false,
    currentlyLocked: false,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  },
  action: 'suspend' as const,
  performedAt: NOW_ISO,
  performedByUserId: 'usr_admin',
  before: {
    status: 'active' as const,
    failedLoginCount: 0,
    lastFailedLoginAt: null,
    lockedUntil: null,
    currentlyLocked: false,
  },
  after: {
    status: 'suspended' as const,
    failedLoginCount: 0,
    lastFailedLoginAt: null,
    lockedUntil: null,
    currentlyLocked: false,
  },
  reason: 'trust_safety',
  note: null,
};

describe('AdminUsersProxyController.suspend (TS-126-followup-1)', () => {
  it('forwards the validated body and idempotency key', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SUSPEND_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.suspend(
      'usr_1',
      { reason: 'trust_safety' },
      'admin-suspend-001',
      REQUEST_WITH_CTX,
    );
    expect(response.action).toBe('suspend');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/users/usr_1/suspend');
    expect(stub.lastOptions?.body).toEqual({ reason: 'trust_safety' });
    expect(stub.lastOptions?.idempotencyKey).toBe('admin-suspend-001');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_admin');
  });

  it('omits Idempotency-Key when the inbound header is absent', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SUSPEND_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await c.suspend('usr_1', { reason: 'trust_safety' }, undefined, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });

  it('URL-encodes the id to defeat path injection', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SUSPEND_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await c.suspend('usr/../admin', { reason: 'trust_safety' }, undefined, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/users/usr%2F..%2Fadmin/suspend');
  });

  it('rejects an unknown reason with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SUSPEND_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.suspend('usr_1', { reason: 'whatever' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects an unknown body field (strict)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SUSPEND_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.suspend(
        'usr_1',
        { reason: 'trust_safety', severity: 'critical' },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SUSPEND_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.suspend('usr_1', { reason: 'trust_safety' }, undefined, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('forwards a downstream 409 verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'Cannot suspend: current status is "suspended", expected "active".',
      currentStatus: 'suspended',
      attempted: 'suspend',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: downstreamBody,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.suspend('usr_1', { reason: 'trust_safety' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 409, response: downstreamBody });
  });

  it('translates downstream timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.suspend('usr_1', { reason: 'trust_safety' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('translates downstream network_error to 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'down' });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.suspend('usr_1', { reason: 'trust_safety' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('translates not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'identity' });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.suspend('usr_1', { reason: 'trust_safety' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { totally: 'wrong' },
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.suspend('usr_1', { reason: 'trust_safety' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('AdminUsersProxyController.reinstate (TS-126-followup-1)', () => {
  it('forwards the validated body to the reinstate path', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: {
        ...VALID_SUSPEND_RESPONSE,
        action: 'reinstate' as const,
        before: { ...VALID_SUSPEND_RESPONSE.before, status: 'suspended' as const },
        after: { ...VALID_SUSPEND_RESPONSE.after, status: 'active' as const },
        reason: 'user_request',
      },
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.reinstate(
      'usr_1',
      { reason: 'user_request' },
      'idem_2',
      REQUEST_WITH_CTX,
    );
    expect(response.action).toBe('reinstate');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/users/usr_1/reinstate');
    expect(stub.lastOptions?.body).toEqual({ reason: 'user_request' });
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_2');
  });

  it('rejects an unknown reason with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SUSPEND_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.reinstate('usr_1', { reason: 'whatever' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });
});

describe('AdminUsersProxyController.unlock (TS-126-followup-1)', () => {
  it('forwards an empty body + idempotency key', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: {
        ...VALID_SUSPEND_RESPONSE,
        action: 'unlock' as const,
        reason: null,
      },
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.unlock('usr_1', {}, 'idem_3', REQUEST_WITH_CTX);
    expect(response.action).toBe('unlock');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/users/usr_1/unlock');
    expect(stub.lastOptions?.body).toEqual({});
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_3');
  });

  it('rejects a `reason` field on the unlock body (strict)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SUSPEND_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.unlock('usr_1', { reason: 'trust_safety' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SUSPEND_RESPONSE,
      setCookies: [],
    });
    const c = new AdminUsersProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.unlock('usr_1', {}, undefined, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
