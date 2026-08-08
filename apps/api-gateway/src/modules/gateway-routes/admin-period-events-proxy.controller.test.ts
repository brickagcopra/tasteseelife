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

import { AdminPeriodEventsProxyController } from './admin-period-events-proxy.controller';

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

const VALID_RESPONSE = {
  events: [
    {
      id: 'ple_1',
      periodId: 'per_a',
      periodName: '2026-05',
      kind: 'close' as const,
      actorUserId: 'usr_admin',
      sourceEventId: 'evt_x',
      reasonCode: 'monthly_close',
      description: 'Routine.',
      occurredAt: NOW_ISO,
      createdAt: NOW_ISO,
    },
  ],
  nextCursor: null,
};

describe('AdminPeriodEventsProxyController.list', () => {
  it('returns the response and URL-encodes the period name', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new AdminPeriodEventsProxyController(stub as unknown as DownstreamHttpClient);
    const response = await c.list('2026-05', { limit: '25' }, REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_RESPONSE);
    expect(stub.lastOptions?.service).toBe('accounting');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/periods/2026-05/events?limit=25');
  });

  it('forwards cursor + limit to the downstream path', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new AdminPeriodEventsProxyController(stub as unknown as DownstreamHttpClient);
    await c.list('2026-05', { cursor: 'cur_x', limit: '50' }, REQUEST_WITH_CTX);
    const url = stub.lastOptions?.path ?? '';
    expect(url).toContain('cursor=cur_x');
    expect(url).toContain('limit=50');
  });

  it('rejects unknown query fields (strict) with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new AdminPeriodEventsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list('2026-05', { extra: 'nope' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
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
    const c = new AdminPeriodEventsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.list('2026-05', {}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('forwards a verbatim 404 from the downstream (unknown period)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found' },
      setCookies: [],
    });
    const c = new AdminPeriodEventsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list('1999-01', { limit: '25' }, REQUEST_WITH_CTX)).rejects.toMatchObject({
      getStatus: expect.any(Function),
    });
  });

  it('returns 502 / 504 / 503 / 502 on downstream failure modes', async () => {
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
      const c = new AdminPeriodEventsProxyController(stub as unknown as DownstreamHttpClient);
      await expect(c.list('2026-05', { limit: '25' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
        ctor,
      );
    }
  });

  it('returns 502 on contract violation from a 200 body', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { malformed: true },
      setCookies: [],
    });
    const c = new AdminPeriodEventsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list('2026-05', { limit: '25' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
