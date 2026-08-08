import {
  BadGatewayException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { TrustSafetyIncidentsProxyController } from './trust-safety-incidents-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW_ISO = '2026-07-02T10:00:00.000Z';

const FAMILY_REQUEST: RequestWithContext = {
  requestContext: {
    userId: 'usr_family',
    mfaVerified: false,
    roles: [
      { name: 'family_payer', permissions: [], scope: { type: 'household', householdId: 'hh_1' } },
    ],
    tenantScope: { type: 'household', householdId: 'hh_1' },
  },
  headers: { 'x-trace-id': 'tr_test_concern' },
} as unknown as RequestWithContext;

const RECEIPT = {
  incidentId: 'inc_1',
  category: 'welfare' as const,
  openedAt: NOW_ISO,
};

const VALID_BODY = {
  category: 'welfare',
  description: 'Mom seemed frightened of her afternoon visitor.',
};

function buildController(stub: StubDownstreamClient): TrustSafetyIncidentsProxyController {
  return new TrustSafetyIncidentsProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 201, body, setCookies: [] };
}

describe('TrustSafetyIncidentsProxyController.report', () => {
  it('forwards a valid report and returns the minimal receipt', async () => {
    const stub = new StubDownstreamClient(ok({ receipt: RECEIPT }));
    const controller = buildController(stub);

    const response = await controller.report(VALID_BODY, 'idem-key-1', FAMILY_REQUEST);

    expect(response.receipt.incidentId).toBe('inc_1');
    expect(stub.lastOptions?.service).toBe('trust-safety');
    expect(stub.lastOptions?.path).toBe('/api/v1/trust-safety/incidents');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_family');
    expect(stub.lastOptions?.traceId).toBe('tr_test_concern');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-key-1');
  });

  it('rejects a malformed body at the gateway without a downstream round trip', async () => {
    const stub = new StubDownstreamClient(ok({ receipt: RECEIPT }));
    const controller = buildController(stub);

    await expect(
      controller.report({ category: 'welfare' }, undefined, FAMILY_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('502s when the downstream body drifts from the receipt contract (leak firewall)', async () => {
    const stub = new StubDownstreamClient(
      ok({ receipt: { ...RECEIPT, severity: 'high', slaDueAt: NOW_ISO } }),
    );
    const controller = buildController(stub);

    await expect(controller.report(VALID_BODY, undefined, FAMILY_REQUEST)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('passes a downstream 400 (non-household scope) through verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 400,
      body: { type: 'about:blank', title: 'Bad Request', status: 400, detail: 'household only' },
    } as DownstreamResult);
    const controller = buildController(stub);

    try {
      await controller.report(VALID_BODY, undefined, FAMILY_REQUEST);
      throw new Error('unexpectedly resolved');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(400);
    }
  });

  it('503s with the env-var name when trust-safety is not configured', async () => {
    const stub = new StubDownstreamClient({
      kind: 'not_configured',
      service: 'trust-safety',
    } as DownstreamResult);
    const controller = buildController(stub);

    try {
      await controller.report(VALID_BODY, undefined, FAMILY_REQUEST);
      throw new Error('unexpectedly resolved');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const body = (err as ServiceUnavailableException).getResponse() as Record<string, unknown>;
      expect(body['detail']).toContain('TRUST_SAFETY_SERVICE_BASE_URL');
    }
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok({ receipt: RECEIPT }));
    const controller = buildController(stub);

    await expect(
      controller.report(VALID_BODY, undefined, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('TrustSafetyIncidentsProxyController — guard metadata', () => {
  it('wears AccessTokenGuard + RateLimitGuard and NO PermissionGuard (customer surface)', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      TrustSafetyIncidentsProxyController,
    ) as unknown[];
    expect(guards).toEqual([AccessTokenGuard, RateLimitGuard]);
  });
});
