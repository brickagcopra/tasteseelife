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
import { PlansProxyController } from './plans-proxy.controller';

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

const VALID_PLANS_PAYLOAD = {
  plans: [
    {
      id: 'plan_essential_family',
      code: 'family.tier1',
      name: 'Family Essential',
      customerGroup: 'family',
      monthlyPriceUsdMinor: 2_900,
      annualPriceUsdMinor: 29_000,
      currency: 'USD',
      features: ['app-access'],
      active: true,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:00.000Z',
    },
  ],
};

describe('PlansProxyController.list', () => {
  it('forwards the call to service-subscription and returns the validated body', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PLANS_PAYLOAD,
      setCookies: [],
    });
    const c = new PlansProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.list(REQUEST_WITH_CTX);
    expect(response.plans).toHaveLength(1);
    expect(response.plans[0]!.code).toBe('family.tier1');
    expect(stub.lastOptions?.service).toBe('subscription');
    expect(stub.lastOptions?.path).toBe('/api/v1/plans');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_abc');
    expect(stub.lastOptions?.traceId).toBe('tr_test_001');
  });

  it('throws UnauthorizedException when the request context is missing', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PLANS_PAYLOAD,
      setCookies: [],
    });
    const c = new PlansProxyController(stub as unknown as DownstreamHttpClient);
    const request = { headers: {} } as unknown as RequestWithContext;
    await expect(c.list(request)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('translates a malformed downstream body into BadGatewayException', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { not: 'a-valid-plans-shape' },
      setCookies: [],
    });
    const c = new PlansProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('forwards downstream 4xx status + body verbatim via HttpException', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Catalog endpoint relocated.',
      },
      setCookies: [],
    });
    const c = new PlansProxyController(stub as unknown as DownstreamHttpClient);
    let caught: HttpException | null = null;
    try {
      await c.list(REQUEST_WITH_CTX);
    } catch (err) {
      caught = err as HttpException;
    }
    expect(caught).not.toBeNull();
    expect(caught!.getStatus()).toBe(404);
    const body = caught!.getResponse() as { detail: string };
    expect(body.detail).toBe('Catalog endpoint relocated.');
  });

  it('translates downstream 5xx into BadGatewayException', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 503,
      body: { detail: 'database unavailable' },
      setCookies: [],
    });
    const c = new PlansProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('translates timeout into GatewayTimeoutException', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = new PlansProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('translates network_error into BadGatewayException', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'ECONNREFUSED' });
    const c = new PlansProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('translates not_configured into ServiceUnavailableException with a specific env-hint detail', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'subscription' });
    const c = new PlansProxyController(stub as unknown as DownstreamHttpClient);
    let caught: ServiceUnavailableException | null = null;
    try {
      await c.list(REQUEST_WITH_CTX);
    } catch (err) {
      caught = err as ServiceUnavailableException;
    }
    expect(caught).not.toBeNull();
    const body = caught!.getResponse() as { detail: string };
    expect(body.detail).toContain('SUBSCRIPTION_SERVICE_BASE_URL');
  });

  it('falls back to x-request-id when x-trace-id is absent', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PLANS_PAYLOAD,
      setCookies: [],
    });
    const c = new PlansProxyController(stub as unknown as DownstreamHttpClient);
    const request = {
      requestContext: {
        userId: 'usr_abc',
        mfaVerified: true,
        roles: [],
        tenantScope: { type: 'global' as const },
      },
      headers: { 'x-request-id': 'req_001' },
    } as unknown as RequestWithContext;
    await c.list(request);
    expect(stub.lastOptions?.traceId).toBe('req_001');
  });
});
