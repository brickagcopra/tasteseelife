import {
  BadGatewayException,
  GatewayTimeoutException,
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

import { AdminBookingHoldsProxyController } from './admin-booking-holds-proxy.controller';

/**
 * Proxy tests for the admin booking-hold read (TS-304-followup-4).
 *
 * The load-bearing assertions:
 *   - gated `trust_safety:read`, not a booking permission;
 *   - the contract's `subjectId`-requires-`subjectKind` refinement bites
 *     at the EDGE, before a downstream call;
 *   - `status` is always sent explicitly, so the default lives in one
 *     place rather than depending on two services agreeing.
 */

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const TS_REQUEST: RequestWithContext = {
  requestContext: {
    userId: 'usr_ts',
    mfaVerified: true,
    roles: [
      {
        name: 'trust_safety',
        permissions: ['trust_safety:read', 'trust_safety:write'],
        scope: { type: 'global' },
      },
    ],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_holds' },
} as unknown as RequestWithContext;

const ROW = {
  id: 'bsh_1',
  incidentId: 'inc_1',
  subjectKind: 'provider',
  subjectId: 'prov_1',
  severity: 'high',
  category: 'safety',
  heldAt: '2026-07-20T10:00:00.000Z',
  releasedAt: null,
  incidentSuspendedBookingCount: 4,
};

const PAGE = { holds: [ROW], total: 12, limit: 50, offset: 0 };

function buildController(stub: StubDownstreamClient): AdminBookingHoldsProxyController {
  return new AdminBookingHoldsProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

function queryOf(stub: StubDownstreamClient): URLSearchParams {
  const path = stub.lastOptions?.path ?? '';
  return new URLSearchParams(path.slice(path.indexOf('?') + 1));
}

describe('AdminBookingHoldsProxyController.listHolds', () => {
  it('forwards to the booking service and returns the parsed page', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    const response = await buildController(stub).listHolds({}, TS_REQUEST);

    expect(stub.lastOptions?.service).toBe('booking');
    expect(stub.lastOptions?.path.startsWith('/api/v1/admin/booking-holds?')).toBe(true);
    expect(response.total).toBe(12);
    expect(response.holds[0]?.incidentSuspendedBookingCount).toBe(4);
  });

  it('always sends status explicitly, defaulting to active', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    await buildController(stub).listHolds({}, TS_REQUEST);

    expect(queryOf(stub).get('status')).toBe('active');
  });

  it('forwards the incident and subject filters', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    await buildController(stub).listHolds(
      { status: 'all', incidentId: 'inc_9', subjectKind: 'senior', subjectId: 'sen_3' },
      TS_REQUEST,
    );

    const search = queryOf(stub);
    expect(search.get('status')).toBe('all');
    expect(search.get('incidentId')).toBe('inc_9');
    expect(search.get('subjectKind')).toBe('senior');
    expect(search.get('subjectId')).toBe('sen_3');
  });

  it('400s on subjectId without subjectKind without calling downstream', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    await expect(
      buildController(stub).listHolds({ subjectId: 'prov_1' }, TS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('400s on an unknown filter key without calling downstream', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    await expect(
      buildController(stub).listHolds({ severity: 'high' }, TS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('502s when the downstream body does not conform to the contract', async () => {
    const stub = new StubDownstreamClient(ok({ holds: [ROW] }));

    await expect(buildController(stub).listHolds({}, TS_REQUEST)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('502s when a downstream row carries a narrative field', async () => {
    const stub = new StubDownstreamClient(
      ok({ ...PAGE, holds: [{ ...ROW, description: 'Daughter reported...' }] }),
    );

    await expect(buildController(stub).listHolds({}, TS_REQUEST)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps a downstream timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' } as unknown as DownstreamResult);

    await expect(buildController(stub).listHolds({}, TS_REQUEST)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('maps an unconfigured booking route to 503 naming the env var', async () => {
    const stub = new StubDownstreamClient({
      kind: 'not_configured',
      service: 'booking',
    } as unknown as DownstreamResult);

    await expect(buildController(stub).listHolds({}, TS_REQUEST)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('401s when the request carries no verified context', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    await expect(
      buildController(stub).listHolds({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('is gated on trust_safety:read behind the token, permission, and rate-limit guards', () => {
    const permissions = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      AdminBookingHoldsProxyController.prototype.listHolds,
    ) as unknown;
    expect(permissions).toEqual(['trust_safety:read']);

    const guards = Reflect.getMetadata('__guards__', AdminBookingHoldsProxyController) as unknown[];
    expect(guards).toEqual([AccessTokenGuard, PermissionGuard, RateLimitGuard]);
  });
});
