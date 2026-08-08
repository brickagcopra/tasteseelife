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

import { InvoicesProxyController } from './invoices-proxy.controller';

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
  headers: { 'x-trace-id': 'tr_inv_001' },
} as unknown as RequestWithContext;

const VALID_INVOICES_BODY = {
  invoices: [
    {
      id: 'in_a',
      subscriptionId: 'sub_local_xyz',
      stripeSubscriptionId: 'sub_stripe_xyz',
      stripeCustomerId: 'cus_test',
      status: 'paid' as const,
      number: 'TASTESEE-0001',
      description: null,
      currency: 'USD' as const,
      amountDueUsdMinor: 29900,
      amountPaidUsdMinor: 29900,
      amountRemainingUsdMinor: 0,
      hostedInvoiceUrl: 'https://invoice.stripe.com/i/in_a',
      invoicePdf: null,
      periodStart: '2026-05-01T00:00:00.000Z',
      periodEnd: '2026-06-01T00:00:00.000Z',
      createdAt: '2026-05-01T00:00:00.000Z',
      paidAt: '2026-05-01T00:00:01.000Z',
      dueAt: null,
    },
  ],
  hasMore: false,
  nextStartingAfter: null,
};

describe('InvoicesProxyController.list', () => {
  it('forwards the query to service-subscription and returns the validated body', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_INVOICES_BODY,
      setCookies: [],
    });
    const c = new InvoicesProxyController(stub as unknown as DownstreamHttpClient);

    const response = await c.list({ subscriptionId: 'sub_local_xyz' }, REQUEST_WITH_CTX);
    expect(response.invoices).toHaveLength(1);
    expect(response.invoices[0]!.id).toBe('in_a');
    expect(stub.lastOptions?.service).toBe('subscription');
    expect(stub.lastOptions?.path).toBe('/api/v1/invoices?subscriptionId=sub_local_xyz&limit=12');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_abc');
    expect(stub.lastOptions?.traceId).toBe('tr_inv_001');
  });

  it('forwards limit + startingAfter when provided', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { ...VALID_INVOICES_BODY, invoices: [] },
      setCookies: [],
    });
    const c = new InvoicesProxyController(stub as unknown as DownstreamHttpClient);

    await c.list(
      { subscriptionId: 'sub_local_xyz', limit: '5', startingAfter: 'in_cursor' },
      REQUEST_WITH_CTX,
    );
    expect(stub.lastOptions?.path).toBe(
      '/api/v1/invoices?subscriptionId=sub_local_xyz&limit=5&startingAfter=in_cursor',
    );
  });

  it('rejects a missing subscriptionId with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_INVOICES_BODY,
      setCookies: [],
    });
    const c = new InvoicesProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects unknown query parameters with 400', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_INVOICES_BODY,
      setCookies: [],
    });
    const c = new InvoicesProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.list({ subscriptionId: 'sub_local_xyz', secret: 'no' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws UnauthorizedException when context is missing', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_INVOICES_BODY,
      setCookies: [],
    });
    const c = new InvoicesProxyController(stub as unknown as DownstreamHttpClient);
    const noCtx = { headers: {} } as unknown as RequestWithContext;
    await expect(c.list({ subscriptionId: 'sub_x' }, noCtx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps a 4xx downstream response to HttpException with the same status', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', detail: 'subscription not found' },
      setCookies: [],
    });
    const c = new InvoicesProxyController(stub as unknown as DownstreamHttpClient);
    await expect(
      c.list({ subscriptionId: 'sub_missing' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('maps a 5xx to 502 Bad Gateway', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 500,
      body: null,
      setCookies: [],
    });
    const c = new InvoicesProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ subscriptionId: 'sub_x' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps timeout to 504 Gateway Timeout', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = new InvoicesProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ subscriptionId: 'sub_x' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('maps not_configured to 503 Service Unavailable', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'subscription' });
    const c = new InvoicesProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ subscriptionId: 'sub_x' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps a malformed success body to BadGatewayException', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { not: 'an invoices list' },
      setCookies: [],
    });
    const c = new InvoicesProxyController(stub as unknown as DownstreamHttpClient);
    await expect(c.list({ subscriptionId: 'sub_x' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
