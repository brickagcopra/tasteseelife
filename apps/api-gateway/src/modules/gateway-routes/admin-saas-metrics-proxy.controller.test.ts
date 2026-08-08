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

import { AdminSaasMetricsProxyController } from './admin-saas-metrics-proxy.controller';

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

const VALID_RESPONSE = {
  metrics: [
    {
      metricDate: '2026-05-28',
      currency: 'USD' as const,
      mrrMinor: 22_800,
      arrMinor: 273_600,
      arpuMinor: 11_400,
      activeSubscriptions: 2,
      newMrrMinor: 0,
      expansionMrrMinor: 0,
      contractionMrrMinor: 0,
      churnedMrrMinor: 0,
      churnedSubscriptions: 0,
      netNewMrrMinor: 0,
      priorMrrMinor: 22_800,
      netRevenueRetentionPpm: 1_027_100,
      grossRevenueRetentionPpm: 992_547,
      ltvMinor: null,
      cacMinor: null,
      comparisonDate: null,
      computedAt: '2026-05-28T02:00:00.000Z',
    },
  ],
  from: '2026-05-28',
  to: '2026-05-28',
};

describe('AdminSaasMetricsProxyController.list', () => {
  it('returns the response unchanged on success', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new AdminSaasMetricsProxyController(stub as unknown as DownstreamHttpClient);
    const response = await c.list({}, REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_RESPONSE);
    expect(stub.lastOptions?.service).toBe('accounting');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/accounting/saas-metrics');
  });

  it('forwards the from/to bounds to the downstream path', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new AdminSaasMetricsProxyController(stub as unknown as DownstreamHttpClient);
    await c.list({ from: '2026-01-01', to: '2026-05-28' }, REQUEST_WITH_CTX);
    const url = stub.lastOptions?.path ?? '';
    expect(url).toContain('from=2026-01-01');
    expect(url).toContain('to=2026-05-28');
  });

  it('rejects unknown query fields (strict) with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new AdminSaasMetricsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ window: '90d' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects a from-after-to range with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new AdminSaasMetricsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.list({ from: '2026-05-28', to: '2026-01-01' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects a datetime bound (must be a calendar date) with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new AdminSaasMetricsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.list({ from: '2026-05-28T00:00:00.000Z' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 401 without a RequestContext', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new AdminSaasMetricsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.list({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps downstream failure modes to 504 / 502 / 503 / 502', async () => {
    const cases: readonly { result: DownstreamResult; ctor: Function }[] = [
      { result: { kind: 'timeout' }, ctor: GatewayTimeoutException },
      {
        result: { kind: 'network_error', detail: 'connection refused' },
        ctor: BadGatewayException,
      },
      {
        result: { kind: 'not_configured', service: 'accounting' },
        ctor: ServiceUnavailableException,
      },
      {
        result: { kind: 'server_error', status: 500, body: {}, setCookies: [] },
        ctor: BadGatewayException,
      },
    ];
    for (const { result, ctor } of cases) {
      const stub = new StubDownstreamClient(result);
      const c = new AdminSaasMetricsProxyController(stub as unknown as DownstreamHttpClient);
      await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(ctor);
    }
  });

  it('forwards a downstream 4xx body verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 403,
      body: { type: 'about:blank', title: 'Forbidden', status: 403 },
      setCookies: [],
    });
    const c = new AdminSaasMetricsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(HttpException);
  });

  it('returns 502 on a contract-violating 200 body', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { metrics: [{ malformed: true }], from: null, to: null },
      setCookies: [],
    });
    const c = new AdminSaasMetricsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
