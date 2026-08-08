import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';
import { AdminConciergeTransportationProxyController } from './admin-concierge-transportation-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const PICKUP = '2026-06-01T14:00:00.000Z';

function requestWithCtx(userId = 'usr_ops'): RequestWithContext {
  return {
    requestContext: {
      userId,
      mfaVerified: true,
      roles: [
        {
          name: 'concierge_lead',
          permissions: ['concierge:read', 'concierge:write'],
          scope: { type: 'global' },
        },
      ],
      tenantScope: { type: 'global' },
    },
    headers: { 'x-trace-id': 'tr_test_001' },
  } as unknown as RequestWithContext;
}

const RIDE = {
  id: 'ride_1',
  householdId: 'hh_1',
  ticketId: null,
  status: 'requested' as const,
  externalProvider: 'manual' as const,
  pickupAddress: '101 Park Ave',
  dropoffAddress: 'Mount Sinai',
  scheduledPickupAt: PICKUP,
  purpose: null,
  riderName: null,
  externalReference: null,
  externalStatus: null,
  notes: null,
  createdByUserId: 'usr_ops',
  createdAt: PICKUP,
  updatedAt: PICKUP,
};

const VALID_LIST_RESPONSE = { requests: [RIDE] };
const VALID_SCHEDULE_RESPONSE = { request: RIDE };
const VALID_UPDATE_RESPONSE = { request: { ...RIDE, status: 'scheduled' as const } };

const VALID_SCHEDULE_BODY = {
  householdId: 'hh_1',
  pickupAddress: '101 Park Ave',
  dropoffAddress: 'Mount Sinai',
  scheduledPickupAt: PICKUP,
};

function buildController(stub: StubDownstreamClient): AdminConciergeTransportationProxyController {
  return new AdminConciergeTransportationProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminConciergeTransportationProxyController.list', () => {
  it('forwards the GET with an allow-listed query string', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);

    const response = await controller.list(
      {
        householdId: 'hh_9',
        ticketId: 'tk_2',
        status: 'scheduled',
        externalProvider: 'uber_health',
        upcomingOnly: 'true',
        limit: '25',
      },
      requestWithCtx(),
    );

    expect(response.requests).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('concierge');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toContain('/api/v1/admin/concierge/transportation?');
    expect(stub.lastOptions?.path).toContain('householdId=hh_9');
    expect(stub.lastOptions?.path).toContain('ticketId=tk_2');
    expect(stub.lastOptions?.path).toContain('status=scheduled');
    expect(stub.lastOptions?.path).toContain('externalProvider=uber_health');
    expect(stub.lastOptions?.path).toContain('upcomingOnly=true');
    expect(stub.lastOptions?.path).toContain('limit=25');
    expect(stub.lastOptions?.traceId).toBe('tr_test_001');
  });

  it('defaults the limit when no query is supplied', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await controller.list({}, requestWithCtx());
    expect(stub.lastOptions?.path).toContain('limit=50');
  });

  it('rejects a malformed query with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await expect(controller.list({ status: 'nope' }, requestWithCtx())).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.list({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ wrong: 'shape' }));
    const controller = buildController(stub);
    await expect(controller.list({}, requestWithCtx())).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps timeout to 504 and not_configured to 503', async () => {
    const timeout = buildController(new StubDownstreamClient({ kind: 'timeout' }));
    await expect(timeout.list({}, requestWithCtx())).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
    const notConfigured = buildController(
      new StubDownstreamClient({ kind: 'not_configured', service: 'concierge' }),
    );
    await expect(notConfigured.list({}, requestWithCtx())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('AdminConciergeTransportationProxyController.schedule', () => {
  it('forwards the POST + body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_SCHEDULE_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.schedule(
      { ...VALID_SCHEDULE_BODY },
      'idem-9',
      requestWithCtx(),
    );
    expect(response.request.id).toBe('ride_1');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/concierge/transportation');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-9');
    // Defaults applied by the contract before forwarding.
    expect(stub.lastOptions?.body).toMatchObject({
      status: 'requested',
      externalProvider: 'manual',
    });
  });

  it('rejects a malformed body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_SCHEDULE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.schedule({ householdId: 'hh_1' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects an initial status of in_progress with 400', async () => {
    const stub = new StubDownstreamClient(ok(VALID_SCHEDULE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.schedule(
        { ...VALID_SCHEDULE_BODY, status: 'in_progress' },
        undefined,
        requestWithCtx(),
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards a downstream 409 (household mismatch) verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'mismatch' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(
      controller.schedule(
        { ...VALID_SCHEDULE_BODY, ticketId: 'tk_x' },
        undefined,
        requestWithCtx(),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('AdminConciergeTransportationProxyController.update', () => {
  it('forwards the PATCH + body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_UPDATE_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.update(
      'ride_1',
      { status: 'scheduled' },
      'idem-10',
      requestWithCtx(),
    );
    expect(response.request.status).toBe('scheduled');
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/concierge/transportation/ride_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-10');
  });

  it('url-encodes the requestId (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_UPDATE_RESPONSE));
    const controller = buildController(stub);
    await controller.update('ride/../admin', { status: 'canceled' }, undefined, requestWithCtx());
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/concierge/transportation/ride%2F..%2Fadmin');
  });

  it('rejects an empty body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_UPDATE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.update('ride_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards a downstream 409 verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'bad move' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(
      controller.update('ride_1', { status: 'completed' }, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('maps a network_error to 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'ECONNREFUSED' });
    const controller = buildController(stub);
    await expect(
      controller.update('ride_1', { notes: 'hi' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
