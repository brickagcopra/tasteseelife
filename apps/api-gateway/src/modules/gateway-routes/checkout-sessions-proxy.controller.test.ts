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

import { CheckoutSessionsProxyController } from './checkout-sessions-proxy.controller';

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

const VALID_BODY = {
  planId: 'plan_companion',
  customerId: 'hh_123',
  customerGroup: 'family' as const,
  customerEmail: 'parent@example.com',
  billingInterval: 'monthly' as const,
  successUrl: 'https://app.tasteandsee.com/checkout/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://app.tasteandsee.com/plans',
};

const VALID_CREATE_RESPONSE = {
  id: 'cs_test_abc',
  url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
  expiresAt: '2026-05-18T00:00:00.000Z',
  status: 'open' as const,
};

const VALID_GET_RESPONSE = {
  id: 'cs_test_abc',
  url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
  expiresAt: '2026-05-18T00:00:00.000Z',
  status: 'complete' as const,
  stripeSubscriptionId: 'sub_stripe_xyz',
  subscriptionId: 'sub_local_xyz',
  customerEmail: 'parent@example.com',
};

const VALID_SUBSCRIPTION_RESPONSE = {
  id: 'sub_local_xyz',
  stripeSubscriptionId: 'sub_stripe_xyz',
  stripeCustomerId: 'cus_xyz',
  customerId: 'hh_123',
  customerGroup: 'family' as const,
  planId: 'plan_companion',
  planCode: 'family.tier2',
  status: 'active' as const,
  billingInterval: 'monthly' as const,
  unitPriceUsdMinor: 19900,
  currency: 'USD' as const,
  currentPeriodStart: '2026-05-17T00:00:00.000Z',
  currentPeriodEnd: '2026-06-17T00:00:00.000Z',
  trialEnd: null,
  cancelAtPeriodEnd: false,
  cancelReason: null,
  canceledAt: null,
  dunningAttempts: 0,
  dunningLastAttemptAt: null,
  dunningGraceUntil: null,
  pauseCollectionStartedAt: null,
  pauseCollectionResumesAt: null,
  pauseReason: null,
  createdAt: '2026-05-17T00:00:00.000Z',
  updatedAt: '2026-05-17T00:00:00.000Z',
};

describe('CheckoutSessionsProxyController.create', () => {
  it('forwards the body to service-subscription and returns the validated response', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 201,
      body: VALID_CREATE_RESPONSE,
      setCookies: [],
    });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.create(VALID_BODY, REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_CREATE_RESPONSE);
    expect(stub.lastOptions?.service).toBe('subscription');
    expect(stub.lastOptions?.path).toBe('/api/v1/subscriptions/checkout-sessions');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_abc');
    expect(stub.lastOptions?.traceId).toBe('tr_test_001');
    expect(stub.lastOptions?.body).toEqual(VALID_BODY);
  });

  // TS-505d-prep-followup-1. Both checkout writes wear `@Idempotent()`
  // downstream, and this is the money path: a double-submitted create is a
  // second Stripe checkout session. The key used to be read into a discarded
  // `_idempotencyKey` parameter, so the downstream replay cache had nothing to
  // key on. These two assert the value survives the edge — the type system can
  // only force the property to be *written*, not to carry the caller's value.
  it("forwards the caller's Idempotency-Key to service-subscription", async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 201,
      body: VALID_CREATE_RESPONSE,
      setCookies: [],
    });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);

    await c.create(VALID_BODY, REQUEST_WITH_CTX, 'checkout-create-hh_123-001');
    expect(stub.lastOptions?.idempotencyKey).toBe('checkout-create-hh_123-001');
  });

  it('forwards undefined when the caller sent no Idempotency-Key', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 201,
      body: VALID_CREATE_RESPONSE,
      setCookies: [],
    });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);

    await c.create(VALID_BODY, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });

  it('rejects a malformed body with 400 before forwarding', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 201,
      body: VALID_CREATE_RESPONSE,
      setCookies: [],
    });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);
    const badBody = { ...VALID_BODY, successUrl: 'not a url' };
    await expect(c.create(badBody, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('throws UnauthorizedException when context is missing', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 201,
      body: VALID_CREATE_RESPONSE,
      setCookies: [],
    });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);
    const noCtx = { headers: {} } as unknown as RequestWithContext;
    await expect(c.create(VALID_BODY, noCtx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a 4xx from downstream to HttpException with the same status', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', detail: 'plan not found' },
      setCookies: [],
    });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.create(VALID_BODY, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(HttpException);
  });

  it('maps a 5xx to 502 Bad Gateway', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 500,
      body: null,
      setCookies: [],
    });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.create(VALID_BODY, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps timeout to 504 Gateway Timeout', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.create(VALID_BODY, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('maps not_configured to 503 Service Unavailable', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'subscription' });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.create(VALID_BODY, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps a malformed downstream success body to BadGatewayException', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 201,
      body: { not: 'a-valid-checkout-session' },
      setCookies: [],
    });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.create(VALID_BODY, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

describe('CheckoutSessionsProxyController.get', () => {
  it('forwards the session id to service-subscription and returns the validated response', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_GET_RESPONSE,
      setCookies: [],
    });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.get('cs_test_abc', REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_GET_RESPONSE);
    expect(stub.lastOptions?.path).toBe('/api/v1/subscriptions/checkout-sessions/cs_test_abc');
    expect(stub.lastOptions?.method).toBe('GET');
  });

  it('URL-encodes the session id', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_GET_RESPONSE,
      setCookies: [],
    });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);

    await c.get('cs/with slash', REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe(
      '/api/v1/subscriptions/checkout-sessions/cs%2Fwith%20slash',
    );
  });
});

describe('CheckoutSessionsProxyController.finalize', () => {
  it('forwards an empty body and returns the validated SubscriptionResponse', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SUBSCRIPTION_RESPONSE,
      setCookies: [],
    });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.finalize(
      'cs_test_abc',
      {},
      REQUEST_WITH_CTX,
      'finalize-cs_test_abc-001',
    );
    // A retried finalize is a second subscription activation, so the key
    // matters at least as much here as on create (TS-505d-prep-followup-1).
    expect(stub.lastOptions?.idempotencyKey).toBe('finalize-cs_test_abc-001');
    expect(response).toEqual(VALID_SUBSCRIPTION_RESPONSE);
    expect(stub.lastOptions?.path).toBe(
      '/api/v1/subscriptions/checkout-sessions/cs_test_abc/finalize',
    );
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.body).toEqual({});
  });

  it('rejects a non-empty body with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SUBSCRIPTION_RESPONSE,
      setCookies: [],
    });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.finalize(
        'cs_test_abc',
        { note: 'stray' } as unknown as Record<string, never>,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('maps a 4xx from downstream to HttpException', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 422,
      body: { type: 'about:blank', title: 'Unprocessable Entity', detail: 'not complete' },
      setCookies: [],
    });
    const c = new CheckoutSessionsProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.finalize('cs_test_abc', {}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});
