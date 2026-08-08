import {
  BadGatewayException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  AccessTokenGuard,
  PermissionGuard,
  REQUIRE_PERMISSIONS_METADATA_KEY,
} from '@taste-and-see/nest-auth';
import type { RequestWithContext } from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import {
  AdminPrivacyRequestsProxyController,
  PrivacyRequestsProxyController,
} from './privacy-requests-proxy.controller';

/**
 * Proxy tests for the Privacy Center (TS-309a-followup-1).
 *
 * The load-bearing assertions:
 *   - the REQUESTER's controller carries **no `PermissionGuard`** — customer
 *     roles hold empty permission sets, so a permission gate there would lock
 *     out exactly the people a statutory right belongs to;
 *   - the operator's routes carry `privacy:read` / `privacy:write`, checked at
 *     the edge as well as downstream;
 *   - a body attempting to name its own `requesterUserId` dies at the edge
 *     without a downstream round trip;
 *   - a drifted downstream body is a 502 — the receipt and the record differ
 *     precisely in what may be disclosed, so drift is a potential
 *     over-disclosure rather than a cosmetic mismatch;
 *   - downstream client errors pass through verbatim, including the 403
 *     `mfa_required` a client needs in order to step up.
 */

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW_ISO = '2026-07-26T12:00:00.000Z';
const DUE_ISO = '2026-09-09T12:00:00.000Z';

const FAMILY_REQUEST: RequestWithContext = {
  requestContext: {
    userId: 'usr_family',
    mfaVerified: true,
    // A customer role with an EMPTY permission set — the shape that makes a
    // permission gate on the requester routes wrong.
    roles: [{ name: 'family_payer', permissions: [], scope: { type: 'global' } }],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_privacy' },
} as unknown as RequestWithContext;

const OPS_REQUEST: RequestWithContext = {
  requestContext: {
    userId: 'usr_ops',
    mfaVerified: true,
    roles: [
      {
        name: 'operations_manager',
        permissions: ['privacy:read', 'privacy:write'],
        scope: { type: 'global' },
      },
    ],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_privacy_ops' },
} as unknown as RequestWithContext;

const RECEIPT = {
  id: 'dsr_1',
  kind: 'access' as const,
  subjectKind: 'user' as const,
  status: 'in_progress' as const,
  selfService: true,
  receivedAt: NOW_ISO,
  dueAt: DUE_ISO,
  extendedAt: null,
  fulfilledAt: null,
  refusalReason: null,
};

const RECORD = {
  ...RECEIPT,
  requesterUserId: 'usr_family',
  subjectId: 'usr_family',
  note: null,
  verifiedAt: NOW_ISO,
  verifiedByUserId: 'usr_family',
  verificationMethod: 'self-service: MFA-verified session for the subject account',
  refusalNote: null,
  withdrawnAt: null,
};

function ok(body: unknown, status = 200): DownstreamResult {
  return { kind: 'ok', status, body, setCookies: [] };
}

function requesterController(stub: StubDownstreamClient): PrivacyRequestsProxyController {
  return new PrivacyRequestsProxyController(stub as unknown as DownstreamHttpClient);
}

function adminController(stub: StubDownstreamClient): AdminPrivacyRequestsProxyController {
  return new AdminPrivacyRequestsProxyController(stub as unknown as DownstreamHttpClient);
}

describe('PrivacyRequestsProxyController — guard metadata', () => {
  it('carries NO PermissionGuard — the gate is being the requester', () => {
    // Customer roles hold empty permission sets. A permission gate here would
    // mean the platform granting people permission to ask what it holds about
    // them, and would lock out exactly the people the routes exist for.
    const guards = Reflect.getMetadata('__guards__', PrivacyRequestsProxyController) as unknown[];

    expect(guards).toEqual([AccessTokenGuard, RateLimitGuard]);
    expect(guards).not.toContain(PermissionGuard);
  });
});

describe('PrivacyRequestsProxyController.file', () => {
  it('forwards a valid request and returns the receipt', async () => {
    const stub = new StubDownstreamClient(ok({ request: RECEIPT }, 201));

    const response = await requesterController(stub).file(
      { kind: 'access' },
      'idem-1',
      FAMILY_REQUEST,
    );

    expect(response.request.id).toBe('dsr_1');
    expect(stub.lastOptions?.service).toBe('identity');
    expect(stub.lastOptions?.path).toBe('/api/v1/privacy/requests');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_family');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-1');
  });

  it('REJECTS a body naming its own requesterUserId, with no downstream call', async () => {
    // The contract has no such field; the requester is stamped from the
    // verified token. Accepting one would make the whole record worthless.
    const stub = new StubDownstreamClient(ok({ request: RECEIPT }, 201));

    await expect(
      requesterController(stub).file(
        { kind: 'access', requesterUserId: 'usr_someone_else' },
        undefined,
        FAMILY_REQUEST,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects half a subject without a downstream round trip', async () => {
    const stub = new StubDownstreamClient(ok({ request: RECEIPT }, 201));

    await expect(
      requesterController(stub).file(
        { kind: 'access', subjectId: 'sen_1' },
        undefined,
        FAMILY_REQUEST,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('502s when the downstream receipt drifts from the contract', async () => {
    // The receipt withholds the verification method and the ids. A drifted
    // body is a potential over-disclosure, not a cosmetic mismatch.
    const stub = new StubDownstreamClient(
      ok({ request: { ...RECEIPT, verificationMethod: 'call-back to the number on file' } }, 201),
    );

    await expect(
      requesterController(stub).file({ kind: 'access' }, undefined, FAMILY_REQUEST),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('passes a downstream 403 mfa_required through verbatim', async () => {
    // The client needs this one unaltered so it can route the user to
    // step-up rather than to a login screen.
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 403,
      body: { type: 'about:blank', title: 'Forbidden', status: 403, code: 'mfa_required' },
    } as DownstreamResult);

    try {
      await requesterController(stub).file({ kind: 'access' }, undefined, FAMILY_REQUEST);
      throw new Error('unexpectedly resolved');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(403);
      expect((err as HttpException).getResponse()).toMatchObject({ code: 'mfa_required' });
    }
  });

  it('503s with the env-var name when identity is not configured', async () => {
    const stub = new StubDownstreamClient({
      kind: 'not_configured',
      service: 'identity',
    } as DownstreamResult);

    try {
      await requesterController(stub).file({ kind: 'access' }, undefined, FAMILY_REQUEST);
      throw new Error('unexpectedly resolved');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const body = (err as ServiceUnavailableException).getResponse() as Record<string, unknown>;
      expect(body['detail']).toContain('IDENTITY_SERVICE_BASE_URL');
    }
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok({ request: RECEIPT }, 201));

    await expect(
      requesterController(stub).file({ kind: 'access' }, undefined, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('PrivacyRequestsProxyController reads and withdraw', () => {
  it('forwards the list', async () => {
    const stub = new StubDownstreamClient(ok({ requests: [RECEIPT] }));

    const response = await requesterController(stub).listMine(FAMILY_REQUEST);

    expect(response.requests).toHaveLength(1);
    expect(stub.lastOptions?.method).toBe('GET');
  });

  it('url-encodes the id on the detail read', async () => {
    const stub = new StubDownstreamClient(ok({ request: RECEIPT }));

    await requesterController(stub).getMine('dsr/../evil', FAMILY_REQUEST);

    expect(stub.lastOptions?.path).toBe('/api/v1/privacy/requests/dsr%2F..%2Fevil');
  });

  it('forwards a withdraw and passes the 404 for someone else’s request through', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', status: 404 },
    } as DownstreamResult);

    try {
      await requesterController(stub).withdraw('dsr_other', undefined, FAMILY_REQUEST);
      throw new Error('unexpectedly resolved');
    } catch (err) {
      // 404 and not 403: on a privacy surface, confirming that a given
      // request exists is itself a disclosure.
      expect((err as HttpException).getStatus()).toBe(404);
    }
    expect(stub.lastOptions?.path).toBe('/api/v1/privacy/requests/dsr_other/withdraw');
  });
});

describe('AdminPrivacyRequestsProxyController — guard metadata', () => {
  it('wears AccessTokenGuard + PermissionGuard + RateLimitGuard, in that order', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      AdminPrivacyRequestsProxyController,
    ) as unknown[];

    expect(guards).toEqual([AccessTokenGuard, PermissionGuard, RateLimitGuard]);
  });

  it('gates the reads on privacy:read and the acts on privacy:write', () => {
    const proto = AdminPrivacyRequestsProxyController.prototype as unknown as Record<
      string,
      object
    >;
    const read = (method: string): unknown => {
      const handler = proto[method];
      if (handler === undefined) throw new Error(`no handler named '${method}'`);
      return Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, handler);
    };

    expect(read('list')).toEqual(['privacy:read']);
    expect(read('get')).toEqual(['privacy:read']);
    expect(read('verify')).toEqual(['privacy:write']);
    expect(read('refuse')).toEqual(['privacy:write']);
    expect(read('extend')).toEqual(['privacy:write']);
  });

  it('exposes NO fulfil and NO withdraw route', () => {
    // Fulfilment belongs to TS-309b's export job — a button asserting it
    // would close a statutory obligation by claiming it was met. Withdrawal
    // is the requester's act; an operator refuses, with a reason.
    const proto = AdminPrivacyRequestsProxyController.prototype as unknown as Record<
      string,
      unknown
    >;
    expect(proto['fulfil']).toBeUndefined();
    expect(proto['withdraw']).toBeUndefined();
  });
});

describe('AdminPrivacyRequestsProxyController', () => {
  it('re-serialises the queue query from the PARSED value', async () => {
    const stub = new StubDownstreamClient(ok({ requests: [RECORD] }));

    await adminController(stub).list({ status: 'verifying', limit: '10' }, OPS_REQUEST);

    expect(stub.lastOptions?.path).toBe('/api/v1/admin/privacy/requests?status=verifying&limit=10');
  });

  it('applies the contract default limit when none is supplied', async () => {
    const stub = new StubDownstreamClient(ok({ requests: [] }));

    await adminController(stub).list({}, OPS_REQUEST);

    expect(stub.lastOptions?.path).toBe('/api/v1/admin/privacy/requests?limit=50');
  });

  it('400s an unknown query key without a downstream round trip', async () => {
    const stub = new StubDownstreamClient(ok({ requests: [] }));

    await expect(
      adminController(stub).list({ nope: 'x' } as Record<string, string>, OPS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards a verify with its method', async () => {
    const stub = new StubDownstreamClient(ok({ request: RECORD }));

    await adminController(stub).verify(
      'dsr_1',
      { method: 'call-back to the number on file' },
      'idem-v',
      OPS_REQUEST,
    );

    expect(stub.lastOptions?.path).toBe('/api/v1/admin/privacy/requests/dsr_1/verify');
    expect(stub.lastOptions?.body).toEqual({ method: 'call-back to the number on file' });
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-v');
  });

  it('400s a verify with no stated method — an unexplained verification is not one', async () => {
    const stub = new StubDownstreamClient(ok({ request: RECORD }));

    await expect(
      adminController(stub).verify('dsr_1', {}, undefined, OPS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('400s a refusal with prose but no categorical reason', async () => {
    const stub = new StubDownstreamClient(ok({ request: RECORD }));

    await expect(
      adminController(stub).refuse('dsr_1', { note: 'we decided not to' }, undefined, OPS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('forwards an extend and passes the 409 for a second one through', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, code: 'already_extended' },
    } as DownstreamResult);

    try {
      await adminController(stub).extend('dsr_1', { reason: 'again' }, undefined, OPS_REQUEST);
      throw new Error('unexpectedly resolved');
    } catch (err) {
      expect((err as HttpException).getStatus()).toBe(409);
    }
  });

  it('502s when the operator record drifts from the contract', async () => {
    const stub = new StubDownstreamClient(ok({ request: { ...RECORD, extra: 'no' } }));

    await expect(adminController(stub).get('dsr_1', OPS_REQUEST)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
