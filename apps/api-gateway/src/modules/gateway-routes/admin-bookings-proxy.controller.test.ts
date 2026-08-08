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

import { AdminBookingsProxyController } from './admin-bookings-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW_ISO = '2026-05-18T12:00:00.000Z';
const LATER_ISO = '2026-05-18T14:00:00.000Z';

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
  bookings: [
    {
      id: 'bkg_1',
      householdId: 'hh_1',
      seniorId: 'sen_1',
      providerId: 'pro_1',
      serviceKind: 'companion_dining' as const,
      status: 'confirmed' as const,
      scheduledStart: NOW_ISO,
      scheduledEnd: LATER_ISO,
      currency: 'USD',
      basePriceMinor: 15000,
      commissionRateBps: 2000,
      commissionAmountMinor: 3000,
      finalPriceMinor: 15000,
      completedAt: null,
      canceledAt: null,
      cancellationReason: null,
      isRecurring: false,
      onHold: false,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  ],
  nextCursor: 'opaque_cursor',
};

const VALID_DETAIL_RESPONSE = {
  booking: {
    id: 'bkg_1',
    householdId: 'hh_1',
    seniorId: 'sen_1',
    providerId: 'pro_1',
    serviceKind: 'companion_dining' as const,
    status: 'completed' as const,
    scheduledStart: NOW_ISO,
    scheduledEnd: LATER_ISO,
    currency: 'USD',
    basePriceMinor: 15000,
    commissionRateBps: 2000,
    commissionAmountMinor: 3000,
    finalPriceMinor: 15000,
    bookingNotes: null,
    completedAt: LATER_ISO,
    canceledAt: null,
    cancellationReason: null,
    cancellationReasonText: null,
    createdAt: NOW_ISO,
    updatedAt: LATER_ISO,
    visitNote: null,
    checkIns: [],
    disputes: [],
    recurrence: null,
  },
};

describe('AdminBookingsProxyController.list', () => {
  it('returns the response and forwards the actor', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.list({ limit: '25' }, REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_LIST_RESPONSE);
    expect(stub.lastOptions?.service).toBe('booking');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/bookings?limit=25');
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
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

    await c.list(
      {
        householdId: 'hh_a',
        providerId: 'pro_a',
        seniorId: 'sen_a',
        serviceKind: 'companion_dining',
        status: 'confirmed',
        cursor: 'cur_abc',
        limit: '50',
      },
      REQUEST_WITH_CTX,
    );
    const path = stub.lastOptions?.path ?? '';
    expect(path).toContain('householdId=hh_a');
    expect(path).toContain('providerId=pro_a');
    expect(path).toContain('seniorId=sen_a');
    expect(path).toContain('serviceKind=companion_dining');
    expect(path).toContain('status=confirmed');
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
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({ smuggled: '1' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects an unknown serviceKind filter with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({ serviceKind: 'mystery' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('rejects an unknown status filter with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

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
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.list({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('translates downstream timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('translates downstream network_error to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'network_error',
      detail: 'connection refused',
    });
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('translates downstream server_error to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 503,
      body: null,
      setCookies: [],
    });
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('translates not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'booking' });
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

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
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

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
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('AdminBookingsProxyController.getById', () => {
  it('forwards the encoded id and returns the response', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DETAIL_RESPONSE,
      setCookies: [],
    });
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.getById('bkg_1', REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_DETAIL_RESPONSE);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/bookings/bkg_1');
  });

  it('URL-encodes the id to defeat path injection', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DETAIL_RESPONSE,
      setCookies: [],
    });
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

    await c.getById('bkg/../admin', REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/bookings/bkg%2F..%2Fadmin');
  });

  it('forwards a downstream 404 verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Booking bkg_missing not found.',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: downstreamBody,
      setCookies: [],
    });
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.getById('bkg_missing', REQUEST_WITH_CTX)).rejects.toMatchObject({
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
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.getById('bkg_1', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { booking: { totally: 'wrong' } },
      setCookies: [],
    });
    const c = new AdminBookingsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.getById('bkg_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
