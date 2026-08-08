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

import { AdminTrialBalanceProxyController } from './admin-trial-balance-proxy.controller';

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
  rows: [
    {
      accountId: 'acc_cash',
      accountCode: '1000',
      accountName: 'Cash',
      accountType: 'asset' as const,
      normalBalance: 'debit' as const,
      debitTotalMinor: 29_900,
      creditTotalMinor: 0,
      netDebitMinor: 29_900,
      netCreditMinor: 0,
      currency: 'USD' as const,
    },
  ],
  totalDebitMinor: 29_900,
  totalCreditMinor: 29_900,
  imbalanceMinor: 0,
  currency: 'USD' as const,
  periodId: null,
  periodName: null,
};

describe('AdminTrialBalanceProxyController.compute', () => {
  it('returns the response unchanged on success', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new AdminTrialBalanceProxyController(stub as unknown as DownstreamHttpClient);
    const response = await c.compute({}, REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_RESPONSE);
    expect(stub.lastOptions?.service).toBe('accounting');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/trial-balance');
  });

  it('forwards every allow-listed filter to the downstream path', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new AdminTrialBalanceProxyController(stub as unknown as DownstreamHttpClient);
    await c.compute(
      { periodId: 'per_x', periodName: '2026-05', currency: 'USD' },
      REQUEST_WITH_CTX,
    );
    const url = stub.lastOptions?.path ?? '';
    expect(url).toContain('periodId=per_x');
    expect(url).toContain('periodName=2026-05');
    expect(url).toContain('currency=USD');
  });

  it('rejects unknown query fields (strict) with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new AdminTrialBalanceProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.compute({ extra: 'nope' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('rejects a non-USD currency with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new AdminTrialBalanceProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.compute({ currency: 'EUR' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('throws 401 without a RequestContext', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new AdminTrialBalanceProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.compute({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 504 / 502 / 503 / 502 on downstream failure modes', async () => {
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
      const c = new AdminTrialBalanceProxyController(stub as unknown as DownstreamHttpClient);
      await expect(c.compute({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(ctor);
    }
  });

  it('returns 502 on contract violation from a 200 body', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { malformed: true },
      setCookies: [],
    });
    const c = new AdminTrialBalanceProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.compute({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
