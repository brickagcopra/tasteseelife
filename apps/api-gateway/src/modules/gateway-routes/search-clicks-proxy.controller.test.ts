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

import { SearchClicksProxyController } from './search-clicks-proxy.controller';

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

const VALID_BODY = { searchId: 'srch_1', providerId: 'prv_9', position: 2 };
const VALID_RESPONSE = { accepted: true };

describe('SearchClicksProxyController.record', () => {
  it('forwards the validated body and returns the response', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 202,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new SearchClicksProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.record(VALID_BODY, REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_RESPONSE);
    expect(stub.lastOptions?.service).toBe('search');
    expect(stub.lastOptions?.path).toBe('/api/v1/search/clicks');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.body).toEqual(VALID_BODY);
    expect(stub.lastOptions?.actor?.userId).toBe('usr_abc');
    expect(stub.lastOptions?.traceId).toBe('tr_test_001');
  });

  it('rejects an unknown body field with 400 (strict)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 202,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new SearchClicksProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.record({ ...VALID_BODY, smuggled: 1 }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('rejects a missing required field with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 202,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new SearchClicksProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.record({ searchId: 'srch_1', providerId: 'prv_9' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws Unauthorized when no requestContext', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 202,
      body: VALID_RESPONSE,
      setCookies: [],
    });
    const c = new SearchClicksProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.record(VALID_BODY, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('re-throws 4xx client errors with the downstream status', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 422,
      body: { type: 'about:blank', title: 'Unprocessable', detail: 'whatever' },
      setCookies: [],
    });
    const c = new SearchClicksProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.record(VALID_BODY, REQUEST_WITH_CTX)).rejects.toMatchObject({ status: 422 });
  });

  it('maps 5xx server_error to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 500,
      body: null,
      setCookies: [],
    });
    const c = new SearchClicksProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.record(VALID_BODY, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = new SearchClicksProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.record(VALID_BODY, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('maps network_error to 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'ECONNREFUSED' });
    const c = new SearchClicksProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.record(VALID_BODY, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'search' });
    const c = new SearchClicksProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.record(VALID_BODY, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps malformed downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 202,
      body: { malformed: true },
      setCookies: [],
    });
    const c = new SearchClicksProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.record(VALID_BODY, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
