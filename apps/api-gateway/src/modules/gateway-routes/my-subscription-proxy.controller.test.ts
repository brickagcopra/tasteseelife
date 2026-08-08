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

import { MySubscriptionProxyController } from './my-subscription-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

function requestWithHousehold(householdId = 'hh_123'): RequestWithContext {
  return {
    requestContext: {
      userId: 'usr_abc',
      mfaVerified: true,
      roles: [],
      tenantScope: { type: 'household', householdId },
    },
    headers: { 'x-trace-id': 'tr_ms_001' },
  } as unknown as RequestWithContext;
}

const VALID_BODY = {
  subscription: {
    planCode: 'tier-2-companion',
    planName: 'Companion Dining',
    status: 'active' as const,
    billingInterval: 'monthly' as const,
    unitPriceUsdMinor: 29900,
    currency: 'USD' as const,
    currentPeriodEnd: '2026-09-01T00:00:00.000Z',
    trialEnd: null,
    cancelAtPeriodEnd: false,
    paymentTrouble: false,
    paymentDueBy: null,
    pauseResumesAt: null,
  },
};

function build(result: DownstreamResult): {
  controller: MySubscriptionProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  return {
    controller: new MySubscriptionProxyController(stub as unknown as DownstreamHttpClient),
    stub,
  };
}

describe('MySubscriptionProxyController.read', () => {
  it('forwards to service-subscription and returns the validated body', async () => {
    const { controller, stub } = build({
      kind: 'ok',
      status: 200,
      body: VALID_BODY,
      setCookies: [],
    });

    const result = await controller.read(requestWithHousehold());

    expect(result).toEqual(VALID_BODY);
    expect(stub.lastOptions?.service).toBe('subscription');
    expect(stub.lastOptions?.path).toBe('/api/v1/subscriptions/me');
  });

  it('carries the household as signed actor context and never in the path', async () => {
    const { controller, stub } = build({
      kind: 'ok',
      status: 200,
      body: VALID_BODY,
      setCookies: [],
    });

    await controller.read(requestWithHousehold('hh_mine'));

    expect(stub.lastOptions?.actor?.tenantScope).toEqual({
      type: 'household',
      householdId: 'hh_mine',
    });
    expect(stub.lastOptions?.path).not.toContain('hh_mine');
  });

  it('passes a null subscription through as a success', async () => {
    const { controller } = build({
      kind: 'ok',
      status: 200,
      body: { subscription: null },
      setCookies: [],
    });

    await expect(controller.read(requestWithHousehold())).resolves.toEqual({
      subscription: null,
    });
  });

  it('502s when the downstream leaks a field the family DTO excludes', async () => {
    // A widened `select:` downstream would put a Stripe id in front of a
    // browser. The re-parse is the control, so drift must not pass.
    const { controller } = build({
      kind: 'ok',
      status: 200,
      body: {
        subscription: { ...VALID_BODY.subscription, stripeCustomerId: 'cus_leak' },
      },
      setCookies: [],
    });

    await expect(controller.read(requestWithHousehold())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('502s when the downstream leaks the dunning attempt count', async () => {
    const { controller } = build({
      kind: 'ok',
      status: 200,
      body: { subscription: { ...VALID_BODY.subscription, dunningAttempts: 3 } },
      setCookies: [],
    });

    await expect(controller.read(requestWithHousehold())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('throws Unauthorized without a request context', async () => {
    const { controller } = build({
      kind: 'ok',
      status: 200,
      body: VALID_BODY,
      setCookies: [],
    });

    await expect(
      controller.read({ headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('passes a downstream client error through verbatim', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'This endpoint is only available to household members.',
    };
    const { controller } = build({
      kind: 'client_error',
      status: 400,
      body: problem,
      setCookies: [],
    });

    const thrown = await controller.read(requestWithHousehold()).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(400);
  });

  it('maps a timeout to 504 and an unconfigured route to 503', async () => {
    const timeout = build({ kind: 'timeout' });
    await expect(timeout.controller.read(requestWithHousehold())).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );

    const unconfigured = build({ kind: 'not_configured', service: 'subscription' });
    await expect(unconfigured.controller.read(requestWithHousehold())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
