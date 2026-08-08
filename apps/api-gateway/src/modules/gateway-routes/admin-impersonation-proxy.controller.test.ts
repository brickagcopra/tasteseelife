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

import { AdminImpersonationProxyController } from './admin-impersonation-proxy.controller';

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

const REQUEST_WITH_CTX: RequestWithContext = {
  requestContext: {
    userId: 'usr_operator',
    mfaVerified: true,
    roles: [
      {
        name: 'super_admin',
        permissions: ['user:impersonate'],
        scope: { type: 'global' },
      },
    ],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_297' },
} as unknown as RequestWithContext;

const VALID_MINT_BODY = {
  accessToken: 'access.jwt',
  tokenType: 'Bearer',
  expiresIn: 900,
  refreshToken: 'raw-refresh',
  sessionFamilyId: 'fam_imp_1',
  sessionExpiresAt: '2026-07-02T13:00:00.000Z',
  operatorUserId: 'usr_operator',
  user: { id: 'usr_target', email: 'target@example.com', status: 'active' },
};

const VALID_END_BODY = {
  sessionFamilyId: 'fam_imp_1',
  ended: true,
  endedAt: '2026-07-02T12:30:00.000Z',
};

function okResult(body: unknown, status = 200): DownstreamResult {
  return { kind: 'ok', status, body, setCookies: [] };
}

function build(result: DownstreamResult): {
  controller: AdminImpersonationProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  return {
    controller: new AdminImpersonationProxyController(stub as unknown as DownstreamHttpClient),
    stub,
  };
}

describe('AdminImpersonationProxyController.impersonate', () => {
  it('proxies the validated body downstream with actor, trace, and idempotency key', async () => {
    const { controller, stub } = build(okResult(VALID_MINT_BODY, 201));

    const response = await controller.impersonate(
      'usr_target',
      { reason: 'diagnose checkout failure' },
      'idem-123',
      REQUEST_WITH_CTX,
    );

    expect(response.sessionFamilyId).toBe('fam_imp_1');
    expect(response.accessToken).toBe('access.jwt');
    expect(stub.lastOptions?.service).toBe('identity');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/users/usr_target/impersonate');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.body).toEqual({ reason: 'diagnose checkout failure' });
    expect(stub.lastOptions?.actor?.userId).toBe('usr_operator');
    expect(stub.lastOptions?.traceId).toBe('tr_test_297');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-123');
  });

  it('400s a payload the contract rejects without calling downstream', async () => {
    const { controller, stub } = build(okResult(VALID_MINT_BODY, 201));
    await expect(
      controller.impersonate('usr_target', { reason: '' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.calls).toBe(0);
  });

  it('502s when the downstream body drifts from the contract (tokens must never pass unchecked)', async () => {
    const { controller } = build(okResult({ ...VALID_MINT_BODY, tokenType: 'MAC' }, 201));
    await expect(
      controller.impersonate('usr_target', { reason: 'x' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('forwards downstream client errors (403 admin-target refusal) verbatim', async () => {
    const { controller } = build({
      kind: 'client_error',
      status: 403,
      body: { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'refused' },
      setCookies: [],
    });
    try {
      await controller.impersonate('usr_colleague', { reason: 'x' }, undefined, REQUEST_WITH_CTX);
      throw new Error('expected HttpException');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(403);
    }
  });

  it('is gated on user:impersonate at the edge', () => {
    expect(
      Reflect.getMetadata(
        REQUIRE_PERMISSIONS_METADATA_KEY,
        AdminImpersonationProxyController.prototype.impersonate,
      ),
    ).toEqual(['user:impersonate']);
  });
});

describe('AdminImpersonationProxyController.end', () => {
  it('proxies the validated end request and returns the receipt', async () => {
    const { controller, stub } = build(okResult(VALID_END_BODY));

    const response = await controller.end(
      { sessionFamilyId: 'fam_imp_1' },
      'idem-456',
      REQUEST_WITH_CTX,
    );

    expect(response.ended).toBe(true);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/impersonation/end');
    expect(stub.lastOptions?.body).toEqual({ sessionFamilyId: 'fam_imp_1' });
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-456');
  });

  it('400s an invalid end payload without calling downstream', async () => {
    const { controller, stub } = build(okResult(VALID_END_BODY));
    await expect(
      controller.end({ sessionFamilyId: '' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.calls).toBe(0);
  });

  it('is gated on user:impersonate at the edge', () => {
    expect(
      Reflect.getMetadata(
        REQUIRE_PERMISSIONS_METADATA_KEY,
        AdminImpersonationProxyController.prototype.end,
      ),
    ).toEqual(['user:impersonate']);
  });
});
