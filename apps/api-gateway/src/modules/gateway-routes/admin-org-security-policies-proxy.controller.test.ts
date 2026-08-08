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

import { AdminOrgSecurityPoliciesProxyController } from './admin-org-security-policies-proxy.controller';

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

const NOW_ISO = '2026-07-02T12:00:00.000Z';

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
  headers: { 'x-trace-id': 'tr_test_296' },
} as unknown as RequestWithContext;

const VALID_POLICY = {
  id: 'pol_1',
  scopeId: 'tenant_abc',
  ssoRequired: true,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

function okResult(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

function build(result: DownstreamResult): {
  controller: AdminOrgSecurityPoliciesProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  return {
    controller: new AdminOrgSecurityPoliciesProxyController(
      stub as unknown as DownstreamHttpClient,
    ),
    stub,
  };
}

describe('AdminOrgSecurityPoliciesProxyController — authorisation metadata', () => {
  it('gates the list on rbac:read and the upsert on rbac:write', () => {
    const list = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      AdminOrgSecurityPoliciesProxyController.prototype.listPolicies,
    ) as readonly string[];
    expect(list).toEqual(['rbac:read']);

    const upsert = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      AdminOrgSecurityPoliciesProxyController.prototype.upsertPolicy,
    ) as readonly string[];
    expect(upsert).toEqual(['rbac:write']);
  });
});

describe('AdminOrgSecurityPoliciesProxyController.listPolicies', () => {
  it('proxies to identity at the same path and parse-checks the response', async () => {
    const { controller, stub } = build(okResult({ policies: [VALID_POLICY] }));

    const response = await controller.listPolicies(REQUEST_WITH_CTX);

    expect(response.policies).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('identity');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/org-security-policies');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.traceId).toBe('tr_test_296');
  });

  it('502s when the downstream body drifts from the contract', async () => {
    const { controller } = build(okResult({ policies: [{ nope: true }] }));
    await expect(controller.listPolicies(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

describe('AdminOrgSecurityPoliciesProxyController.upsertPolicy', () => {
  it('validates then forwards the body + Idempotency-Key to identity', async () => {
    const { controller, stub } = build(okResult({ policy: VALID_POLICY }));

    const response = await controller.upsertPolicy(
      'tenant_abc',
      { ssoRequired: true },
      'idem-123',
      REQUEST_WITH_CTX,
    );

    expect(response.policy.scopeId).toBe('tenant_abc');
    expect(stub.lastOptions?.method).toBe('PUT');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/org-security-policies/tenant_abc');
    expect(stub.lastOptions?.body).toEqual({ ssoRequired: true });
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-123');
  });

  it('400s a malformed scope id without calling downstream', async () => {
    const { controller, stub } = build(okResult({ policy: VALID_POLICY }));

    await expect(
      controller.upsertPolicy('bad scope!', { ssoRequired: true }, undefined, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 400 });
    expect(stub.calls).toBe(0);
  });

  it('400s an unknown-field payload without calling downstream (strict contract)', async () => {
    const { controller, stub } = build(okResult({ policy: VALID_POLICY }));

    await expect(
      controller.upsertPolicy(
        'tenant_abc',
        { ssoRequired: true, extra: 1 },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(stub.calls).toBe(0);
  });

  it('replays a downstream client error verbatim (e.g. identity 403)', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Missing permission.',
    };
    const { controller } = build({
      kind: 'client_error',
      status: 403,
      body: problem,
      setCookies: [],
    });

    try {
      await controller.upsertPolicy(
        'tenant_abc',
        { ssoRequired: false },
        undefined,
        REQUEST_WITH_CTX,
      );
      throw new Error('expected HttpException');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(403);
    }
  });
});
