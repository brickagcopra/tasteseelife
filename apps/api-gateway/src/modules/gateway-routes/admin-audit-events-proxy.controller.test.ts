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

import { AdminAuditEventsProxyController } from './admin-audit-events-proxy.controller';

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
        permissions: ['audit:read'],
        scope: { type: 'global' },
      },
    ],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_295' },
} as unknown as RequestWithContext;

const VALID_EVENT = {
  id: 'ae_1',
  eventId: 'evt_1',
  occurredAt: NOW_ISO,
  actorUserId: 'usr_actor',
  actorRole: 'super_admin',
  actorTenantScopeType: 'global',
  actorTenantScopeId: null,
  action: 'rbac_role:create',
  resourceKind: 'rbac_role',
  resourceId: 'role_1',
  beforeJson: null,
  afterJson: { name: 'regional_ops' },
  ip: null,
  userAgent: null,
  requestId: null,
  traceId: null,
  chainPrevHash: null,
  chainHash: 'a'.repeat(64),
  createdAt: NOW_ISO,
};

function okResult(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

function build(result: DownstreamResult): {
  controller: AdminAuditEventsProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  return {
    controller: new AdminAuditEventsProxyController(stub as unknown as DownstreamHttpClient),
    stub,
  };
}

describe('AdminAuditEventsProxyController by-resource-kind', () => {
  it('proxies with the allow-listed query rebuilt and forwards the actor', async () => {
    const { controller, stub } = build(okResult({ events: [VALID_EVENT], nextCursor: null }));

    const response = await controller.listByResourceKind(
      {
        resourceKinds: 'rbac_role,rbac_assignment,rbac_approval',
        order: 'desc',
        limit: '50',
      },
      REQUEST_WITH_CTX,
    );

    expect(response.events).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('audit');
    expect(stub.lastOptions?.path).toBe(
      '/api/v1/admin/audit/events/by-resource-kind?resourceKinds=rbac_role%2Crbac_assignment%2Crbac_approval&order=desc&limit=50',
    );
    expect(stub.lastOptions?.actor?.userId).toBe('usr_admin');
    expect(stub.lastOptions?.traceId).toBe('tr_test_295');
  });

  it('forwards the optional action + actor filters when set', async () => {
    const { controller, stub } = build(okResult({ events: [], nextCursor: null }));

    await controller.listByResourceKind(
      {
        resourceKinds: 'rbac_role',
        action: 'rbac_role:archive',
        actorUserId: 'usr_actor',
      },
      REQUEST_WITH_CTX,
    );

    expect(stub.lastOptions?.path).toContain('action=rbac_role%3Aarchive');
    expect(stub.lastOptions?.path).toContain('actorUserId=usr_actor');
  });

  it('rejects an unknown query param without calling the downstream', async () => {
    const { controller, stub } = build(okResult({ events: [], nextCursor: null }));

    await expect(
      controller.listByResourceKind({ resourceKinds: 'rbac_role', nope: '1' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.calls).toBe(0);
  });

  it('rejects more than five resource kinds without calling the downstream', async () => {
    const { controller, stub } = build(okResult({ events: [], nextCursor: null }));

    await expect(
      controller.listByResourceKind({ resourceKinds: 'a,b,c,d,e,f' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.calls).toBe(0);
  });

  it('502s when the downstream body does not conform to the contract', async () => {
    const { controller } = build(okResult({ events: [{ nope: true }], nextCursor: null }));

    await expect(
      controller.listByResourceKind({ resourceKinds: 'rbac_role' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('AdminAuditEventsProxyController by-resource / by-actor', () => {
  it('proxies by-resource with both required fields', async () => {
    const { controller, stub } = build(okResult({ events: [VALID_EVENT], nextCursor: 'c_next' }));

    const response = await controller.listByResource(
      { resourceKind: 'rbac_role', resourceId: 'role_1' },
      REQUEST_WITH_CTX,
    );

    expect(response.nextCursor).toBe('c_next');
    expect(stub.lastOptions?.path).toContain('/by-resource?resourceKind=rbac_role');
    expect(stub.lastOptions?.path).toContain('resourceId=role_1');
  });

  it('proxies by-actor and forwards the cursor', async () => {
    const { controller, stub } = build(okResult({ events: [], nextCursor: null }));

    await controller.listByActor({ actorUserId: 'usr_actor', cursor: 'c_1' }, REQUEST_WITH_CTX);

    expect(stub.lastOptions?.path).toContain('/by-actor?actorUserId=usr_actor');
    expect(stub.lastOptions?.path).toContain('cursor=c_1');
  });

  it('forwards a downstream 4xx verbatim', async () => {
    const { controller } = build({
      kind: 'client_error',
      status: 400,
      body: { type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Bad cursor.' },
      setCookies: [],
    });

    const attempt = controller.listByActor({ actorUserId: 'usr_actor' }, REQUEST_WITH_CTX);
    await expect(attempt).rejects.toBeInstanceOf(HttpException);
    await attempt.catch((err: HttpException) => expect(err.getStatus()).toBe(400));
  });
});

describe('AdminAuditEventsProxyController permission gating (TS-295)', () => {
  function requiredPermissions(handler: object): unknown {
    return Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, handler);
  }

  it('gates every read on audit:read', () => {
    expect(
      requiredPermissions(AdminAuditEventsProxyController.prototype.listByResourceKind),
    ).toEqual(['audit:read']);
    expect(requiredPermissions(AdminAuditEventsProxyController.prototype.listByResource)).toEqual([
      'audit:read',
    ]);
    expect(requiredPermissions(AdminAuditEventsProxyController.prototype.listByActor)).toEqual([
      'audit:read',
    ]);
  });
});
