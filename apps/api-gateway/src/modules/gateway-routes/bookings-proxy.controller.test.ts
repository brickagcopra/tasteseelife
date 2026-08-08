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

import { BookingsProxyController } from './bookings-proxy.controller';

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
    userId: 'usr_abc',
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_001' },
} as unknown as RequestWithContext;

const VALID_CONCIERGE_BODY = {
  householdId: 'hh_abc',
  seniorId: 'snr_abc',
  providerId: 'prv_abc',
  serviceKind: 'companion_dining' as const,
  scheduledStart: '2026-06-10T17:00:00.000Z',
  scheduledEnd: '2026-06-10T19:00:00.000Z',
};

const VALID_BOOKING_RESPONSE = {
  id: 'bkg_1',
  householdId: 'hh_abc',
  seniorId: 'snr_abc',
  providerId: 'prv_abc',
  serviceKind: 'companion_dining' as const,
  status: 'pending' as const,
  scheduledStart: '2026-06-10T17:00:00.000Z',
  scheduledEnd: '2026-06-10T19:00:00.000Z',
  currency: 'USD',
  basePriceMinor: 15_000,
  commissionRateBps: 2_000,
  commissionAmountMinor: 3_000,
  finalPriceMinor: 15_000,
  bookingNotes: null,
  completedAt: null,
  canceledAt: null,
  cancellationReason: null,
  cancellationReasonText: null,
  acceptWindowExpiresAt: '2026-05-13T12:30:00.000Z',
  declinedAt: null,
  declineKind: null,
  declineReason: null,
  declineReasonText: null,
  declinedByUserId: null,
  onHold: false,
  createdAt: '2026-05-13T12:00:00.000Z',
  updatedAt: '2026-05-13T12:00:00.000Z',
};

describe('BookingsProxyController.createConciergeRequest', () => {
  it('forwards the validated body and returns the response', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 201,
      body: VALID_BOOKING_RESPONSE,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.createConciergeRequest(VALID_CONCIERGE_BODY, REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_BOOKING_RESPONSE);
    expect(stub.lastOptions?.service).toBe('booking');
    expect(stub.lastOptions?.path).toBe('/api/v1/bookings/concierge-request');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_abc');
  });

  it('rejects a malformed body with 400 (strict — extra field)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 201,
      body: VALID_BOOKING_RESPONSE,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.createConciergeRequest({ ...VALID_CONCIERGE_BODY, basePriceMinor: 99 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws Unauthorized when no requestContext', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 201,
      body: VALID_BOOKING_RESPONSE,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.createConciergeRequest(VALID_CONCIERGE_BODY, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('re-throws 409 tier-gating conflicts verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', detail: 'tier rejected' },
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.createConciergeRequest(VALID_CONCIERGE_BODY, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('maps malformed downstream booking response to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 201,
      body: { malformed: true },
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.createConciergeRequest(VALID_CONCIERGE_BODY, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('BookingsProxyController.list', () => {
  const validList = { bookings: [VALID_BOOKING_RESPONSE], nextCursor: null };

  it('forwards the query (allow-listed) and returns the validated list', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: validList,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    const response = await c.list({ householdId: 'hh_abc' }, REQUEST_WITH_CTX);
    expect(response.bookings).toHaveLength(1);
    expect(response.nextCursor).toBeNull();
    expect(stub.lastOptions?.service).toBe('booking');
    expect(stub.lastOptions?.path).toContain('householdId=hh_abc');
    expect(stub.lastOptions?.path).toContain('limit=20');
  });

  it('forwards a cursor when supplied', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: validList,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await c.list({ householdId: 'hh_abc', cursor: 'next_page' }, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toContain('cursor=next_page');
  });

  it('rejects an unknown query field with 400 (strict)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: validList,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.list({ householdId: 'hh_abc', smuggled: '1' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws Unauthorized when no requestContext', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: validList,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.list({ householdId: 'hh_abc' }, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a missing householdId with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: validList,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(HttpException);
  });

  it('maps not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'booking' });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ householdId: 'hh_abc' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('BookingsProxyController.getMyDashboard', () => {
  const VALID_DASHBOARD = {
    householdId: 'hh_abc',
    seniorId: null,
    windowDays: 30 as const,
    upcoming: [VALID_BOOKING_RESPONSE],
    history: [{ booking: VALID_BOOKING_RESPONSE, visitNotes: null }],
    historyNextCursor: null,
  };

  it('forwards the allow-listed query (no householdId on the wire) and returns the validated dashboard', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DASHBOARD,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    const response = await c.getMyDashboard(
      { windowDays: '90', seniorId: 'snr_abc', historyCursor: 'cur', historyLimit: '25' },
      REQUEST_WITH_CTX,
    );
    expect(response.upcoming).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('booking');
    expect(stub.lastOptions?.path).toContain('/api/v1/bookings/dashboard/me?');
    expect(stub.lastOptions?.path).toContain('windowDays=90');
    expect(stub.lastOptions?.path).toContain('seniorId=snr_abc');
    expect(stub.lastOptions?.path).toContain('historyCursor=cur');
    expect(stub.lastOptions?.path).toContain('historyLimit=25');
    expect(stub.lastOptions?.path).not.toContain('householdId');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_abc');
  });

  it('applies query defaults when omitted', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DASHBOARD,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await c.getMyDashboard({}, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toContain('windowDays=30');
    expect(stub.lastOptions?.path).toContain('historyLimit=10');
  });

  it('rejects an unsupported windowDays with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DASHBOARD,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.getMyDashboard({ windowDays: '45' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('rejects an unknown query field with 400 (strict)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DASHBOARD,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.getMyDashboard({ smuggled: '1' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('re-throws the downstream 400 (non-household actor) verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 400,
      body: { type: 'about:blank', title: 'Bad Request', detail: 'household members only' },
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.getMyDashboard({}, REQUEST_WITH_CTX)).rejects.toMatchObject({ status: 400 });
  });

  it('maps a malformed downstream dashboard response to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { malformed: true },
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.getMyDashboard({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('throws Unauthorized when no requestContext', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DASHBOARD,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.getMyDashboard({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.getMyDashboard({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });
});

describe('BookingsProxyController.getById', () => {
  it('forwards the id (URL-encoded) and returns the booking', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_BOOKING_RESPONSE,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    const response = await c.getById('bkg_1', REQUEST_WITH_CTX);
    expect(response.id).toBe('bkg_1');
    expect(stub.lastOptions?.path).toBe('/api/v1/bookings/bkg_1');
  });

  it('throws Unauthorized when no requestContext', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_BOOKING_RESPONSE,
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.getById('bkg_1', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('re-throws 404 from downstream verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found' },
      setCookies: [],
    });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.getById('bkg_missing', REQUEST_WITH_CTX)).rejects.toMatchObject({ status: 404 });
  });

  it('maps timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = new BookingsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.getById('bkg_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });
});
