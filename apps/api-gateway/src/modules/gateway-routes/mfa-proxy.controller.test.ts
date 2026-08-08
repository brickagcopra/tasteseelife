import { HttpException, HttpStatus } from '@nestjs/common';
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

import { MfaProxyController } from './mfa-proxy.controller';

/**
 * Proxy tests for authenticated MFA management (TS-309d-followup-1).
 *
 * The load-bearing assertions:
 *   - NO `PermissionGuard`, because customer roles carry empty permission sets
 *     and a permission gate would refuse exactly the population these routes
 *     exist for;
 *   - the subject is never taken from the body or the path — one customer
 *     cannot enrol or remove a factor for another;
 *   - the one-time recovery codes survive the confirm hop.
 */

class StubDownstreamClient {
  public readonly calls: DownstreamCallOptions[] = [];
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.calls.push(options);
    return this.result as DownstreamResult<TBody>;
  }
}

const CUSTOMER: RequestWithContext = {
  requestContext: {
    userId: 'usr_family',
    mfaVerified: false,
    // A family payer holds NO permissions — this is the seeded reality, and it
    // is why this controller has no PermissionGuard.
    roles: [{ name: 'family_payer', permissions: [], scope: { type: 'global' } }],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_mfa' },
} as unknown as RequestWithContext;

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

function build(result: DownstreamResult): {
  controller: MfaProxyController;
  client: StubDownstreamClient;
} {
  const client = new StubDownstreamClient(result);
  return {
    controller: new MfaProxyController(client as unknown as DownstreamHttpClient),
    client,
  };
}

const ENROLL_BODY = {
  methodId: 'mfa_1',
  secretBase32: 'JBSWY3DPEHPK3PXP',
  otpauthUrl: 'otpauth://totp/TasteAndSee:someone@example.com?secret=JBSWY3DPEHPK3PXP',
};

// Crockford base32 — I, L, O and U are excluded from the alphabet precisely
// because they are confusable when a customer reads a code off a printout.
const RECOVERY_CODES = [
  'ABCDE-FGHJK',
  'MNPQR-STVWX',
  'YZ012-34567',
  '89ABC-DEFGH',
  'JKMNP-QRSTV',
  'WXYZ0-12345',
  '6789A-BCDEF',
  'GHJKM-NPQRS',
];

const CONFIRM_REQUEST = { methodId: 'mfa_1', code: '123456' };

const CONFIRM_BODY = {
  mfaEnabled: true as const,
  recoveryCodes: RECOVERY_CODES,
};

describe('MfaProxyController — guards', () => {
  it('sits behind access-token and rate-limit guards only', () => {
    // The absence of PermissionGuard is the assertion. Customer roles are
    // seeded with empty permission sets, so gating these routes on a
    // permission would lock out the very users who need to enrol.
    const guards: unknown[] = Reflect.getMetadata('__guards__', MfaProxyController) ?? [];
    expect(guards).toEqual([AccessTokenGuard, RateLimitGuard]);
    expect(guards).not.toContain(PermissionGuard);
  });

  it('declares no required permissions on any route', () => {
    for (const handler of [
      MfaProxyController.prototype.enroll,
      MfaProxyController.prototype.confirm,
      MfaProxyController.prototype.list,
      MfaProxyController.prototype.remove,
    ]) {
      expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, handler)).toBeUndefined();
    }
  });
});

describe('MfaProxyController — enrolment', () => {
  it('forwards enrolment with the verified actor attached', async () => {
    const { controller, client } = build(ok(ENROLL_BODY));
    const response = await controller.enroll({}, undefined, CUSTOMER);

    expect(response).toEqual(ENROLL_BODY);
    expect(client.calls[0]).toMatchObject({
      service: 'identity',
      path: '/api/v1/auth/mfa/totp/enroll',
      method: 'POST',
      traceId: 'tr_mfa',
    });
    // The subject travels in the signed actor envelope, never in the payload.
    expect(client.calls[0]?.actor?.userId).toBe('usr_family');
  });

  it('REJECTS a caller who tries to name a different subject', async () => {
    // service-identity reads the subject from the verified token, so a
    // smuggled `userId` could never have taken effect — but the request schema
    // is `.strict()`, so it does not reach the wire at all. A 400 at the edge
    // beats a silently-dropped field: one tells the caller they are wrong, the
    // other lets them keep believing the parameter works.
    const { controller, client } = build(ok(ENROLL_BODY));
    await expect(
      controller.enroll({ userId: 'usr_someone_else' }, undefined, CUSTOMER),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    expect(client.calls).toHaveLength(0);
  });

  it('carries the one-time recovery codes through confirm', async () => {
    // They cross this hop exactly once and are never re-readable —
    // `MfaListResponse` has no field for them. A portal that does not show
    // them here has lost them.
    const { controller } = build(ok(CONFIRM_BODY));
    const response = await controller.confirm(CONFIRM_REQUEST, undefined, CUSTOMER);
    expect(response.recoveryCodes).toEqual(RECOVERY_CODES);
  });

  it('502s rather than returning a code-less confirmation', async () => {
    // A downstream that stopped returning recovery codes would otherwise look
    // like a successful enrolment with nothing to write down.
    const { controller } = build(ok({ mfaEnabled: true }));
    await expect(controller.confirm(CONFIRM_REQUEST, undefined, CUSTOMER)).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
    });
  });

  it('forwards an Idempotency-Key on both write routes', async () => {
    const { controller, client } = build(ok(ENROLL_BODY));
    await controller.enroll({}, 'idem-1', CUSTOMER);
    expect(client.calls[0]?.idempotencyKey).toBe('idem-1');
  });
});

describe('MfaProxyController — methods', () => {
  it('lists the caller’s own factors', async () => {
    const { controller, client } = build(ok({ methods: [] }));
    const response = await controller.list(CUSTOMER);
    expect(response).toEqual({ methods: [] });
    expect(client.calls[0]).toMatchObject({
      path: '/api/v1/auth/mfa/methods',
      method: 'GET',
    });
    expect(client.calls[0]?.actor?.userId).toBe('usr_family');
  });

  it('encodes the method id into the path', async () => {
    const { controller, client } = build(ok({ removed: true }));
    await controller.remove('a/b', CUSTOMER);
    expect(client.calls[0]?.path).toBe('/api/v1/auth/mfa/methods/a%2Fb');
  });

  it('propagates a downstream 404 rather than inventing a success', async () => {
    const { controller } = build({
      kind: 'client_error',
      status: 404,
      body: { detail: 'no such method' },
      setCookies: [],
    });
    await expect(controller.remove('mfa_missing', CUSTOMER)).rejects.toBeInstanceOf(HttpException);
  });

  it('surfaces an unconfigured identity route as a 503 naming the env var', async () => {
    const { controller } = build({ kind: 'not_configured', service: 'identity' });
    await expect(controller.list(CUSTOMER)).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });
});
