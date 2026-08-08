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

import { AdminChartOfAccountsProxyController } from './admin-chart-of-accounts-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW_ISO = '2026-05-18T12:00:00.000Z';

const REQUEST_WITH_CTX: RequestWithContext = {
  requestContext: {
    userId: 'usr_admin',
    mfaVerified: true,
    roles: [{ name: 'super_admin', permissions: [], scope: { type: 'global' } }],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_coa' },
} as unknown as RequestWithContext;

const VALID_LIST_RESPONSE = {
  accounts: [
    {
      id: 'coa_cash',
      code: '1000',
      name: 'Cash',
      description: 'Operating bank + Stripe balance.',
      type: 'asset' as const,
      parentId: null,
      normalBalance: 'debit' as const,
      currency: 'USD' as const,
      active: true,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
    {
      id: 'coa_retired',
      code: '1900',
      name: 'Retired Suspense',
      type: 'asset' as const,
      parentId: null,
      normalBalance: 'debit' as const,
      currency: 'USD' as const,
      active: false,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  ],
};

const VALID_SET_ACTIVE_RESPONSE = {
  account: {
    id: 'coa_cash',
    code: '1000',
    name: 'Cash',
    type: 'asset' as const,
    parentId: null,
    normalBalance: 'debit' as const,
    currency: 'USD' as const,
    active: false,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  },
  performedAt: NOW_ISO,
  performedByUserId: 'usr_admin',
  before: { active: true },
  after: { active: false },
  reason: 'chart_cleanup' as const,
  note: 'Replaced by 1000.cash.stripe.',
};

describe('AdminChartOfAccountsProxyController.list', () => {
  it('returns the response and forwards the actor', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.list({}, REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_LIST_RESPONSE);
    expect(stub.lastOptions?.service).toBe('accounting');
    expect(stub.lastOptions?.path).toBe('/api/v1/accounts');
  });

  it('forwards activeOnly=false through to the downstream', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await c.list({ activeOnly: 'false' }, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/accounts?activeOnly=false');
  });

  it('forwards type + parentId filters through', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await c.list({ type: 'revenue', parentId: 'coa_4000', activeOnly: 'false' }, REQUEST_WITH_CTX);
    const path = stub.lastOptions?.path ?? '';
    expect(path).toContain('type=revenue');
    expect(path).toContain('parentId=coa_4000');
    expect(path).toContain('activeOnly=false');
  });

  it('rejects unknown query fields (strict) with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ extra: 'nope' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 401 when the upstream did not attach a RequestContext', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.list({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 502 on contract violation from a 200 body', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { malformed: true },
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('returns 504 on downstream timeout', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('returns 503 when the downstream is not configured', async () => {
    const stub = new StubDownstreamClient({
      kind: 'not_configured',
      service: 'accounting',
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('AdminChartOfAccountsProxyController.setActive', () => {
  it('returns the response and URL-encodes the path id', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SET_ACTIVE_RESPONSE,
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    const response = await c.setActive(
      'coa with spaces',
      { active: false, reason: 'chart_cleanup', note: 'Replaced by 1000.cash.stripe.' },
      undefined,
      REQUEST_WITH_CTX,
    );

    expect(response).toEqual(VALID_SET_ACTIVE_RESPONSE);
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.service).toBe('accounting');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/accounts/coa%20with%20spaces');
    expect(stub.lastOptions?.body).toEqual({
      active: false,
      reason: 'chart_cleanup',
      note: 'Replaced by 1000.cash.stripe.',
    });
  });

  it('forwards Idempotency-Key when supplied', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SET_ACTIVE_RESPONSE,
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await c.setActive(
      'coa_cash',
      { active: false, reason: 'chart_cleanup' },
      'idem-set-active-2026-05-18-001',
      REQUEST_WITH_CTX,
    );
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-set-active-2026-05-18-001');
  });

  it('omits Idempotency-Key from the downstream call when none was supplied', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SET_ACTIVE_RESPONSE,
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await c.setActive(
      'coa_cash',
      { active: false, reason: 'chart_cleanup' },
      undefined,
      REQUEST_WITH_CTX,
    );
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });

  it('rejects an unknown reason with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SET_ACTIVE_RESPONSE,
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.setActive('coa_cash', { active: false, reason: 'mystery' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects a missing active field with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SET_ACTIVE_RESPONSE,
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.setActive('coa_cash', { reason: 'chart_cleanup' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects unknown body fields (strict) with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SET_ACTIVE_RESPONSE,
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.setActive(
        'coa_cash',
        { active: false, reason: 'chart_cleanup', extra: 'x' },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 401 when the upstream did not attach a RequestContext', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SET_ACTIVE_RESPONSE,
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.setActive('coa_cash', { active: false, reason: 'chart_cleanup' }, undefined, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('forwards a verbatim 404 from the downstream', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', detail: 'gone' },
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.setActive(
        'coa_missing',
        { active: false, reason: 'chart_cleanup' },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toMatchObject({ getStatus: expect.any(Function) });
  });

  it('returns 502 on contract violation from a 200 body', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { wrong: 'shape' },
      setCookies: [],
    });
    const c = new AdminChartOfAccountsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.setActive(
        'coa_cash',
        { active: false, reason: 'chart_cleanup' },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
