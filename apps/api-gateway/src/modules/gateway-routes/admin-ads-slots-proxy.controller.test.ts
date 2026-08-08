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

import { AdminAdsSlotsProxyController } from './admin-ads-slots-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW = '2026-06-15T12:00:00.000Z';

function requestWithCtx(userId = 'usr_admin'): RequestWithContext {
  return {
    requestContext: {
      userId,
      mfaVerified: true,
      roles: [
        { name: 'marketing', permissions: ['ads:read', 'ads:write'], scope: { type: 'global' } },
      ],
      tenantScope: { type: 'global' },
    },
    headers: { 'x-trace-id': 'tr_slot_001' },
  } as unknown as RequestWithContext;
}

const PLACEMENT = {
  id: 'plc_1',
  slotCode: 'home_banner',
  supportedCreativeKinds: ['banner'] as const,
  createdAt: NOW,
  updatedAt: NOW,
};

const SCHEDULE = {
  id: 'sch_1',
  placementId: 'plc_1',
  campaignId: 'cmp_1',
  status: 'scheduled' as const,
  priority: 0,
  startAt: NOW,
  endAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const VALID_PLACEMENTS_RESPONSE = { placements: [PLACEMENT] };
const VALID_SCHEDULES_RESPONSE = { schedules: [SCHEDULE] };
const VALID_SCHEDULE_RESPONSE = { schedule: SCHEDULE };

const VALID_CREATE_BODY = { placementId: 'plc_1', campaignId: 'cmp_1', startAt: NOW };

function buildController(stub: StubDownstreamClient): AdminAdsSlotsProxyController {
  return new AdminAdsSlotsProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminAdsSlotsProxyController.listPlacements', () => {
  it('forwards the GET to the placements path', async () => {
    const stub = new StubDownstreamClient(ok(VALID_PLACEMENTS_RESPONSE));
    const controller = buildController(stub);

    const response = await controller.listPlacements(requestWithCtx());
    expect(response.placements).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('ads');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/ads/placements');
    expect(stub.lastOptions?.traceId).toBe('tr_slot_001');
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(VALID_PLACEMENTS_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.listPlacements({ headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ wrong: 'shape' }));
    const controller = buildController(stub);
    await expect(controller.listPlacements(requestWithCtx())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

describe('AdminAdsSlotsProxyController.listSchedules', () => {
  it('forwards the GET with an allow-listed query string', async () => {
    const stub = new StubDownstreamClient(ok(VALID_SCHEDULES_RESPONSE));
    const controller = buildController(stub);

    const response = await controller.listSchedules(
      { placementId: 'plc_1', campaignId: 'cmp_1', status: 'active', limit: '25' },
      requestWithCtx(),
    );

    expect(response.schedules).toHaveLength(1);
    expect(stub.lastOptions?.path).toContain('/api/v1/admin/ads/slot-schedules?');
    expect(stub.lastOptions?.path).toContain('placementId=plc_1');
    expect(stub.lastOptions?.path).toContain('campaignId=cmp_1');
    expect(stub.lastOptions?.path).toContain('status=active');
    expect(stub.lastOptions?.path).toContain('limit=25');
  });

  it('defaults the limit when no query is supplied', async () => {
    const stub = new StubDownstreamClient(ok(VALID_SCHEDULES_RESPONSE));
    const controller = buildController(stub);
    await controller.listSchedules({}, requestWithCtx());
    expect(stub.lastOptions?.path).toContain('limit=50');
  });

  it('rejects a malformed query with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_SCHEDULES_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.listSchedules({ status: 'nope' }, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('maps timeout to 504 and not_configured to 503', async () => {
    const timeout = buildController(new StubDownstreamClient({ kind: 'timeout' }));
    await expect(timeout.listSchedules({}, requestWithCtx())).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
    const notConfigured = buildController(
      new StubDownstreamClient({ kind: 'not_configured', service: 'ads' }),
    );
    await expect(notConfigured.listSchedules({}, requestWithCtx())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('AdminAdsSlotsProxyController.create', () => {
  it('forwards the POST + body + Idempotency-Key with contract defaults', async () => {
    const stub = new StubDownstreamClient(ok(VALID_SCHEDULE_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.create({ ...VALID_CREATE_BODY }, 'idem-1', requestWithCtx());
    expect(response.schedule.id).toBe('sch_1');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/ads/slot-schedules');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-1');
    expect(stub.lastOptions?.body).toMatchObject({ priority: 0, status: 'scheduled' });
  });

  it('rejects a malformed body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_SCHEDULE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.create({ placementId: 'plc_1' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects a window that ends before it starts with 400', async () => {
    const stub = new StubDownstreamClient(ok(VALID_SCHEDULE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.create({ ...VALID_CREATE_BODY, endAt: NOW }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards a downstream 422 (unknown placement) verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 422,
      body: {
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'no placement',
      },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(
      controller.create({ ...VALID_CREATE_BODY }, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('AdminAdsSlotsProxyController.detail', () => {
  it('forwards the GET and url-encodes the scheduleId', async () => {
    const stub = new StubDownstreamClient(ok(VALID_SCHEDULE_RESPONSE));
    const controller = buildController(stub);
    await controller.detail('sch/../admin', requestWithCtx());
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/ads/slot-schedules/sch%2F..%2Fadmin');
  });

  it('maps a downstream 404 verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', status: 404, detail: 'no schedule' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(controller.detail('sch_x', requestWithCtx())).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('AdminAdsSlotsProxyController.update', () => {
  it('forwards the PATCH + body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(
      ok({ schedule: { ...SCHEDULE, status: 'active' as const } }),
    );
    const controller = buildController(stub);
    const response = await controller.update(
      'sch_1',
      { status: 'active' },
      'idem-2',
      requestWithCtx(),
    );
    expect(response.schedule.status).toBe('active');
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/ads/slot-schedules/sch_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-2');
  });

  it('rejects an empty body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_SCHEDULE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.update('sch_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards a downstream 409 (illegal transition) verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'bad transition' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(
      controller.update('sch_1', { status: 'completed' }, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('maps a network_error to 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'ECONNREFUSED' });
    const controller = buildController(stub);
    await expect(
      controller.update('sch_1', { priority: 5 }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
