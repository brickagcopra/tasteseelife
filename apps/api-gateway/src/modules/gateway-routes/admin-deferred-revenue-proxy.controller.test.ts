import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { AdminDeferredRevenueProxyController } from './admin-deferred-revenue-proxy.controller';

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
    roles: [{ name: 'super_admin', permissions: [], scope: { type: 'global' } }],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_001' },
} as unknown as RequestWithContext;

const VALID_BALANCE = {
  balanceId: 'drb_1',
  subscriptionId: 'sub_1',
  customerId: 'hh_1',
  customerGroup: 'family' as const,
  planCode: 'family.tier2',
  currency: 'USD' as const,
  pausedAt: '2026-05-01T00:00:00.000Z',
  pausedForSeconds: 2_678_400,
  priorPausedSeconds: 0,
  servicePeriodStart: '2026-04-01T00:00:00.000Z',
  servicePeriodEnd: '2026-05-15T00:00:00.000Z',
  pastServicePeriodEnd: true,
  originalAmountMinor: 29_900,
  recognizedAmountMinor: 12_000,
  remainingDeferredMinor: 17_900,
};

const VALID_RESPONSE = {
  asOf: '2026-06-01T00:00:00.000Z',
  summary: {
    pausedCount: 12,
    pastServicePeriodEndCount: 1,
    unknownPausedAtCount: 0,
    oldestPausedAt: '2026-05-01T00:00:00.000Z',
    totalRemainingDeferredMinor: 214_800,
    currency: 'USD' as const,
  },
  balances: [VALID_BALANCE],
  truncated: true,
};

function okStub(body: unknown): StubDownstreamClient {
  return new StubDownstreamClient({ kind: 'ok', status: 200, body, setCookies: [] });
}

describe('AdminDeferredRevenueProxyController.listPaused', () => {
  it('returns the response unchanged on success', async () => {
    const stub = okStub(VALID_RESPONSE);
    const c = new AdminDeferredRevenueProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.listPaused({}, REQUEST_WITH_CTX);

    expect(response).toEqual(VALID_RESPONSE);
    expect(stub.lastOptions?.service).toBe('accounting');
    // The default limit is resolved by the schema and forwarded explicitly.
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/deferred-revenue/paused?limit=50');
  });

  it('forwards limit + asOf to the downstream path', async () => {
    const stub = okStub(VALID_RESPONSE);
    const c = new AdminDeferredRevenueProxyController(stub as unknown as DownstreamHttpClient);

    await c.listPaused({ limit: '10', asOf: '2026-05-20T09:30:00.000Z' }, REQUEST_WITH_CTX);

    expect(stub.lastOptions?.path).toContain('limit=10');
    expect(stub.lastOptions?.path).toContain(
      `asOf=${encodeURIComponent('2026-05-20T09:30:00.000Z')}`,
    );
  });

  it('preserves an uncapped count beside a truncated page', async () => {
    // The disclosure this proxy is guarding: the count must survive the hop
    // intact, or "how much revenue is stranded" quietly becomes "how much
    // fitted on one page".
    const stub = okStub(VALID_RESPONSE);
    const c = new AdminDeferredRevenueProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.listPaused({}, REQUEST_WITH_CTX);

    expect(response.summary.pausedCount).toBe(12);
    expect(response.balances).toHaveLength(1);
    expect(response.truncated).toBe(true);
  });

  it('rejects an unknown query parameter with a 400', async () => {
    const stub = okStub(VALID_RESPONSE);
    const c = new AdminDeferredRevenueProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.listPaused({ status: 'paused' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('rejects a limit above the contract cap', async () => {
    const stub = okStub(VALID_RESPONSE);
    const c = new AdminDeferredRevenueProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.listPaused({ limit: '5000' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('502s when the downstream body drifts from the contract', async () => {
    // A cursor is exactly the drift that matters: it would imply the count
    // is a page count.
    const stub = okStub({ ...VALID_RESPONSE, nextCursor: 'abc' });
    const c = new AdminDeferredRevenueProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.listPaused({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('502s when a balance row loses its pause instant field entirely', async () => {
    const { pausedAt: _dropped, ...withoutPausedAt } = VALID_BALANCE;
    const stub = okStub({ ...VALID_RESPONSE, balances: [withoutPausedAt] });
    const c = new AdminDeferredRevenueProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.listPaused({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('passes a downstream client error through with its status', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 403,
      body: { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'nope' },
      setCookies: [],
    });
    const c = new AdminDeferredRevenueProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.listPaused({}, REQUEST_WITH_CTX)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('maps a downstream 5xx to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 500,
      body: null,
      setCookies: [],
    });
    const c = new AdminDeferredRevenueProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.listPaused({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = new AdminDeferredRevenueProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.listPaused({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('maps an unconfigured route to 503 naming the env var', async () => {
    const stub = new StubDownstreamClient({
      kind: 'not_configured',
      service: 'accounting',
    });
    const c = new AdminDeferredRevenueProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.listPaused({}, REQUEST_WITH_CTX)).rejects.toMatchObject({
      status: 503,
    });
  });

  it('401s when the request carries no context', async () => {
    const stub = okStub(VALID_RESPONSE);
    const c = new AdminDeferredRevenueProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.listPaused({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a network error to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'network_error',
      detail: 'ECONNREFUSED',
    });
    const c = new AdminDeferredRevenueProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.listPaused({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
