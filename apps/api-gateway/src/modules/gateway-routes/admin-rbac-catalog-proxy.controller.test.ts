import 'reflect-metadata';

import { BadGatewayException, GatewayTimeoutException } from '@nestjs/common';
import { REQUIRE_PERMISSIONS_METADATA_KEY } from '@taste-and-see/nest-auth';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { AdminRbacCatalogProxyController } from './admin-rbac-catalog-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const REQUEST_WITH_CTX: RequestWithContext = {
  requestContext: {
    userId: 'usr_admin',
    mfaVerified: true,
    roles: [{ name: 'super_admin', permissions: ['rbac:read'], scope: { type: 'global' } }],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_299' },
} as unknown as RequestWithContext;

const VALID_ENVELOPE = {
  formatVersion: 1,
  exportedAt: '2026-07-02T12:00:00.000Z',
  permissions: [{ resource: 'rbac', action: 'read', description: 'Read the catalog.' }],
  roles: [
    {
      name: 'read_only_auditor',
      description: 'Auditor.',
      isSystem: true,
      permissions: ['rbac:read'],
    },
  ],
};

function build(result: DownstreamResult): {
  controller: AdminRbacCatalogProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  return {
    controller: new AdminRbacCatalogProxyController(stub as unknown as DownstreamHttpClient),
    stub,
  };
}

describe('AdminRbacCatalogProxyController export', () => {
  it('proxies to service-identity at the same path, forwarding actor + trace', async () => {
    const { controller, stub } = build({
      kind: 'ok',
      status: 200,
      body: VALID_ENVELOPE,
      setCookies: [],
    });

    const response = await controller.exportCatalog(REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_ENVELOPE);
    expect(stub.lastOptions?.service).toBe('identity');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/rbac-catalog/export');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_admin');
    expect(stub.lastOptions?.traceId).toBe('tr_test_299');
  });

  it('502s on a body that drifts from the envelope contract (never forwards it)', async () => {
    const { controller } = build({
      kind: 'ok',
      status: 200,
      body: { ...VALID_ENVELOPE, formatVersion: 99 },
      setCookies: [],
    });
    await expect(controller.exportCatalog(REQUEST_WITH_CTX)).rejects.toThrowError(
      BadGatewayException,
    );
  });

  it('maps downstream timeout / server-error kinds to gateway problems', async () => {
    const timeout = build({ kind: 'timeout', service: 'identity' } as DownstreamResult);
    await expect(timeout.controller.exportCatalog(REQUEST_WITH_CTX)).rejects.toThrowError(
      GatewayTimeoutException,
    );

    const serverError = build({
      kind: 'server_error',
      status: 500,
      body: null,
    } as DownstreamResult);
    await expect(serverError.controller.exportCatalog(REQUEST_WITH_CTX)).rejects.toThrowError(
      BadGatewayException,
    );
  });

  it('gates on rbac:read and exposes no import route', () => {
    const permissions = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      AdminRbacCatalogProxyController.prototype.exportCatalog,
    ) as unknown;
    expect(permissions).toEqual(['rbac:read']);

    const routeMethods = Object.getOwnPropertyNames(
      AdminRbacCatalogProxyController.prototype,
    ).filter((name) => name !== 'constructor');
    expect(routeMethods).toEqual(['exportCatalog']);
  });
});
