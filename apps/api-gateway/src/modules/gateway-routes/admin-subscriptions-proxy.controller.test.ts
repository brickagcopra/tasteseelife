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

import { AdminSubscriptionsProxyController } from './admin-subscriptions-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW_ISO = '2026-05-17T12:00:00.000Z';

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
  subscriptions: [
    {
      id: 'sub_1',
      stripeSubscriptionId: 'sub_stripe_1',
      stripeCustomerId: 'cus_1',
      customerId: 'hh_1',
      customerGroup: 'family' as const,
      planId: 'plan_tier2',
      planCode: 'family.tier2',
      planName: 'Companion Dining',
      status: 'active' as const,
      billingInterval: 'monthly' as const,
      unitPriceMinor: 29900,
      currency: 'USD',
      currentPeriodStart: NOW_ISO,
      currentPeriodEnd: NOW_ISO,
      trialEnd: null,
      cancelAtPeriodEnd: false,
      cancelReason: null,
      canceledAt: null,
      inDunningGrace: false,
      isPaused: false,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  ],
  nextCursor: 'opaque_cursor',
};

const VALID_DETAIL_RESPONSE = {
  subscription: {
    id: 'sub_1',
    stripeSubscriptionId: 'sub_stripe_1',
    stripeCustomerId: 'cus_1',
    customerId: 'hh_1',
    customerGroup: 'family' as const,
    status: 'active' as const,
    billingInterval: 'monthly' as const,
    unitPriceMinor: 29900,
    currency: 'USD',
    currentPeriodStart: NOW_ISO,
    currentPeriodEnd: NOW_ISO,
    trialEnd: null,
    cancelAtPeriodEnd: false,
    cancelReason: null,
    canceledAt: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    plan: {
      id: 'plan_tier2',
      code: 'family.tier2',
      name: 'Companion Dining',
      customerGroup: 'family' as const,
      monthlyPriceMinor: 29900,
      annualPriceMinor: 299000,
      currency: 'USD',
      active: true,
    },
    defaultPaymentMethod: null,
    dunning: {
      attempts: 0,
      lastAttemptAt: null,
      graceUntil: null,
      inGracePeriod: false,
    },
    pause: {
      isPaused: false,
      pauseCollectionStartedAt: null,
      pauseCollectionResumesAt: null,
      pauseReason: null,
    },
    history: [],
  },
};

describe('AdminSubscriptionsProxyController.list', () => {
  it('returns the response and forwards the actor', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.list({ limit: '25' }, REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_LIST_RESPONSE);
    expect(stub.lastOptions?.service).toBe('subscription');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/subscriptions?limit=25');
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
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

    await c.list(
      {
        customerGroup: 'provider',
        status: 'past_due',
        planId: 'plan_a',
        customerId: 'hh_a',
        cursor: 'cur_abc',
        limit: '50',
      },
      REQUEST_WITH_CTX,
    );
    const path = stub.lastOptions?.path ?? '';
    expect(path).toContain('customerGroup=provider');
    expect(path).toContain('status=past_due');
    expect(path).toContain('planId=plan_a');
    expect(path).toContain('customerId=hh_a');
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
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({ smuggled: '1' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects an unknown customerGroup filter with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({ customerGroup: 'mystery' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
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
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.list({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('translates downstream timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('translates downstream network_error to 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'connection refused' });
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('translates downstream server_error to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 503,
      body: null,
      setCookies: [],
    });
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('translates not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'subscription' });
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

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
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

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
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('AdminSubscriptionsProxyController.getById', () => {
  it('forwards the encoded id and returns the response', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DETAIL_RESPONSE,
      setCookies: [],
    });
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.getById('sub_1', REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_DETAIL_RESPONSE);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/subscriptions/sub_1');
  });

  it('URL-encodes the id to defeat path injection', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DETAIL_RESPONSE,
      setCookies: [],
    });
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

    await c.getById('sub/../admin', REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/subscriptions/sub%2F..%2Fadmin');
  });

  it('forwards a downstream 404 verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Subscription sub_missing not found.',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: downstreamBody,
      setCookies: [],
    });
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.getById('sub_missing', REQUEST_WITH_CTX)).rejects.toMatchObject({
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
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(
      c.getById('sub_1', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { subscription: { totally: 'wrong' } },
      setCookies: [],
    });
    const c = new AdminSubscriptionsProxyController(stub as unknown as DownstreamHttpClient);

    await expect(c.getById('sub_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
