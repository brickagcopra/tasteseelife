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

import { AdminJournalsProxyController } from './admin-journals-proxy.controller';

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
  headers: { 'x-trace-id': 'tr_test_001' },
} as unknown as RequestWithContext;

const VALID_LIST_RESPONSE = {
  journals: [
    {
      id: 'jnl_1',
      kind: 'subscription_activation' as const,
      occurredAt: NOW_ISO,
      postedAt: NOW_ISO,
      sourceEventId: 'evt_x',
      description: 'Activation',
      periodId: 'per_a',
      periodName: '2026-05',
      postedByUserId: null,
      reversedJournalId: null,
      reversedByJournalId: null,
      lineCount: 2,
      totalDebitMinor: 29_900,
      totalCreditMinor: 29_900,
      currency: 'USD' as const,
    },
  ],
  nextCursor: 'opaque_cursor',
};

const VALID_DETAIL_RESPONSE = {
  journal: {
    id: 'jnl_1',
    kind: 'subscription_activation' as const,
    occurredAt: NOW_ISO,
    postedAt: NOW_ISO,
    sourceEventId: 'evt_x',
    description: 'Activation',
    periodId: 'per_a',
    periodName: '2026-05',
    postedByUserId: null,
    reversedJournalId: null,
    reversedByJournalId: null,
    totalDebitMinor: 29_900,
    totalCreditMinor: 29_900,
    currency: 'USD' as const,
    context: {},
    lines: [
      {
        id: 'jln_a',
        accountId: 'acc_cash',
        accountCode: '1000',
        accountName: 'Cash',
        debitMinor: 29_900,
        creditMinor: 0,
        currency: 'USD' as const,
        memo: null,
      },
      {
        id: 'jln_b',
        accountId: 'acc_def',
        accountCode: '2000.family.tier2',
        accountName: 'Deferred Revenue T2',
        debitMinor: 0,
        creditMinor: 29_900,
        currency: 'USD' as const,
        memo: null,
      },
    ],
  },
};

describe('AdminJournalsProxyController.list', () => {
  it('returns the response and forwards the actor', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminJournalsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.list({ limit: '25' }, REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_LIST_RESPONSE);
    expect(stub.lastOptions?.service).toBe('accounting');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/journals?limit=25');
  });

  it('forwards every allow-listed filter to the downstream path', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminJournalsProxyController(stub as unknown as DownstreamHttpClient);
    await c.list(
      {
        periodId: 'per_x',
        periodName: '2026-05',
        kind: 'booking_completion',
        cursor: 'cur_x',
        limit: '50',
      },
      REQUEST_WITH_CTX,
    );
    const url = stub.lastOptions?.path ?? '';
    expect(url).toContain('periodId=per_x');
    expect(url).toContain('periodName=2026-05');
    expect(url).toContain('kind=booking_completion');
    expect(url).toContain('cursor=cur_x');
    expect(url).toContain('limit=50');
  });

  it('rejects unknown query fields (strict) with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminJournalsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ extra: 'nope' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects an unknown JournalKind with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminJournalsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ kind: 'mystery' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('rejects a malformed periodName with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminJournalsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ periodName: 'May 2026' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('throws 401 when the upstream did not attach a RequestContext', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminJournalsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.list({ limit: '25' }, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 504 on downstream timeout', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = new AdminJournalsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ limit: '25' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('returns 502 on downstream network error', async () => {
    const stub = new StubDownstreamClient({
      kind: 'network_error',
      detail: 'connection refused',
    });
    const c = new AdminJournalsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ limit: '25' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('returns 502 on downstream server error', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 500,
      body: { type: 'about:blank', title: 'Server Error' },
      setCookies: [],
    });
    const c = new AdminJournalsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ limit: '25' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('returns 503 when the downstream is not configured', async () => {
    const stub = new StubDownstreamClient({
      kind: 'not_configured',
      service: 'accounting',
    });
    const c = new AdminJournalsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ limit: '25' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('forwards a verbatim 4xx (e.g. 403 from downstream)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 403,
      body: { type: 'about:blank', title: 'Forbidden', detail: 'no' },
      setCookies: [],
    });
    const c = new AdminJournalsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ limit: '25' }, REQUEST_WITH_CTX)).rejects.toMatchObject({
      getStatus: expect.any(Function),
    });
  });

  it('returns 502 on contract violation from a 200 body', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { malformed: true },
      setCookies: [],
    });
    const c = new AdminJournalsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ limit: '25' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

describe('AdminJournalsProxyController.getById', () => {
  it('returns the detail response and URL-encodes the path id', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DETAIL_RESPONSE,
      setCookies: [],
    });
    const c = new AdminJournalsProxyController(stub as unknown as DownstreamHttpClient);
    const response = await c.getById('jnl_with spaces', REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_DETAIL_RESPONSE);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/journals/jnl_with%20spaces');
  });

  it('forwards a 404 verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found' },
      setCookies: [],
    });
    const c = new AdminJournalsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.getById('jnl_nope', REQUEST_WITH_CTX)).rejects.toMatchObject({
      getStatus: expect.any(Function),
    });
  });
});
