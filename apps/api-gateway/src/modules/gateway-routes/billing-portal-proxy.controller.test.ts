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

import { BillingPortalProxyController } from './billing-portal-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

/**
 * A request as it reaches this handler: `HouseholdScopeInterceptor` has
 * already narrowed the scope from `global` to the caller's household.
 */
function requestWithHousehold(householdId = 'hh_123'): RequestWithContext {
  return {
    requestContext: {
      userId: 'usr_abc',
      mfaVerified: true,
      roles: [],
      tenantScope: { type: 'household', householdId },
    },
    headers: { 'x-trace-id': 'tr_bp_001', 'idempotency-key': 'idem-billing-portal-0001' },
  } as unknown as RequestWithContext;
}

const VALID_BODY = { url: 'https://billing.stripe.com/p/session/live_abc' };

function build(result: DownstreamResult): {
  controller: BillingPortalProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  const controller = new BillingPortalProxyController(stub as unknown as DownstreamHttpClient);
  return { controller, stub };
}

describe('BillingPortalProxyController.create', () => {
  it('forwards to service-subscription and returns the validated body', async () => {
    const { controller, stub } = build({
      kind: 'ok',
      status: 201,
      body: VALID_BODY,
      setCookies: [],
    });

    const result = await controller.create({}, requestWithHousehold());

    expect(result).toEqual(VALID_BODY);
    expect(stub.lastOptions?.service).toBe('subscription');
    expect(stub.lastOptions?.path).toBe('/api/v1/billing/portal-sessions');
    expect(stub.lastOptions?.method).toBe('POST');
  });

  it('carries the household as signed actor context, never as a parameter', async () => {
    const { controller, stub } = build({
      kind: 'ok',
      status: 201,
      body: VALID_BODY,
      setCookies: [],
    });

    await controller.create({}, requestWithHousehold('hh_mine'));

    // The scope rides in the trust envelope the client signs from
    // `actor`; the path and body stay free of ids entirely.
    expect(stub.lastOptions?.actor?.tenantScope).toEqual({
      type: 'household',
      householdId: 'hh_mine',
    });
    expect(stub.lastOptions?.path).not.toContain('hh_mine');
    expect(JSON.stringify(stub.lastOptions?.body ?? {})).not.toContain('hh_mine');
  });

  it('forwards the caller’s Idempotency-Key', async () => {
    const { controller, stub } = build({
      kind: 'ok',
      status: 201,
      body: VALID_BODY,
      setCookies: [],
    });

    await controller.create({}, requestWithHousehold());

    expect(stub.lastOptions?.idempotencyKey).toBe('idem-billing-portal-0001');
  });

  it('treats an absent body as empty rather than a validation error', async () => {
    const { controller } = build({ kind: 'ok', status: 201, body: VALID_BODY, setCookies: [] });

    await expect(controller.create(undefined, requestWithHousehold())).resolves.toEqual(VALID_BODY);
  });

  it('REJECTS a body naming a customer, before any downstream call', async () => {
    const { controller, stub } = build({
      kind: 'ok',
      status: 201,
      body: VALID_BODY,
      setCookies: [],
    });

    await expect(
      controller.create({ customerId: 'cus_someone_else' }, requestWithHousehold()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('REJECTS a caller-supplied returnUrl — that would be an open redirect', async () => {
    const { controller, stub } = build({
      kind: 'ok',
      status: 201,
      body: VALID_BODY,
      setCookies: [],
    });

    await expect(
      controller.create({ returnUrl: 'https://phishing.example' }, requestWithHousehold()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('throws Unauthorized when the request carries no context', async () => {
    const { controller } = build({ kind: 'ok', status: 201, body: VALID_BODY, setCookies: [] });

    await expect(
      controller.create({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('502s when the downstream body drifts from the contract', async () => {
    // A widened downstream projection would leak the Stripe customer id
    // to a browser. Drift is a gateway failure, not a passthrough.
    const { controller } = build({
      kind: 'ok',
      status: 201,
      body: { ...VALID_BODY, customer: 'cus_test', livemode: true },
      setCookies: [],
    });

    await expect(controller.create({}, requestWithHousehold())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('passes a downstream client error through verbatim', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'No active plan found for your household.',
    };
    const { controller } = build({
      kind: 'client_error',
      status: 404,
      body: problem,
      setCookies: [],
    });

    const thrown = await controller.create({}, requestWithHousehold()).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(404);
    expect((thrown as HttpException).getResponse()).toEqual(problem);
  });

  it('maps a downstream server error to 502', async () => {
    const { controller } = build({ kind: 'server_error', status: 500, body: null, setCookies: [] });
    await expect(controller.create({}, requestWithHousehold())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps a timeout to 504', async () => {
    const { controller } = build({ kind: 'timeout' });
    await expect(controller.create({}, requestWithHousehold())).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('maps an unconfigured route to 503', async () => {
    const { controller } = build({ kind: 'not_configured', service: 'subscription' });
    await expect(controller.create({}, requestWithHousehold())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
