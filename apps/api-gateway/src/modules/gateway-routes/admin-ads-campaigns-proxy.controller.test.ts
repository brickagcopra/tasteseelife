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

import { AdminAdsCampaignsProxyController } from './admin-ads-campaigns-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW = '2026-06-13T12:00:00.000Z';

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
    headers: { 'x-trace-id': 'tr_ads_001' },
  } as unknown as RequestWithContext;
}

const CAMPAIGN = {
  id: 'cmp_1',
  name: 'Spring sponsored chefs',
  advertiserKind: 'provider' as const,
  advertiserId: 'prv_9',
  status: 'draft' as const,
  budgetMinor: 500000,
  currency: 'USD',
  startAt: null,
  endAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const CREATIVE = {
  id: 'crv_1',
  campaignId: 'cmp_1',
  kind: 'sponsored_listing' as const,
  assetKeys: [],
  headline: 'Meet chef Aria',
  body: null,
  ctaUrl: null,
  status: 'draft' as const,
  createdAt: NOW,
  updatedAt: NOW,
};

const CAMPAIGN_DETAIL = { ...CAMPAIGN, creatives: [CREATIVE], targetingRules: [] };

const VALID_LIST_RESPONSE = { campaigns: [CAMPAIGN] };
const VALID_CAMPAIGN_RESPONSE = { campaign: CAMPAIGN };
const VALID_DETAIL_RESPONSE = { campaign: CAMPAIGN_DETAIL };
const VALID_CREATIVE_RESPONSE = { creative: { ...CREATIVE, status: 'pending_review' as const } };

const VALID_CREATE_BODY = {
  name: 'Spring sponsored chefs',
  advertiserKind: 'provider',
  advertiserId: 'prv_9',
};

function buildController(stub: StubDownstreamClient): AdminAdsCampaignsProxyController {
  return new AdminAdsCampaignsProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminAdsCampaignsProxyController.list', () => {
  it('forwards the GET with an allow-listed query string', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);

    const response = await controller.list(
      { status: 'active', advertiserKind: 'provider', limit: '25' },
      requestWithCtx(),
    );

    expect(response.campaigns).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('ads');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toContain('/api/v1/admin/ads/campaigns?');
    expect(stub.lastOptions?.path).toContain('status=active');
    expect(stub.lastOptions?.path).toContain('advertiserKind=provider');
    expect(stub.lastOptions?.path).toContain('limit=25');
    expect(stub.lastOptions?.traceId).toBe('tr_ads_001');
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
      new StubDownstreamClient({ kind: 'not_configured', service: 'ads' }),
    );
    await expect(notConfigured.list({}, requestWithCtx())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('AdminAdsCampaignsProxyController.create', () => {
  it('forwards the POST + body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_CAMPAIGN_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.create({ ...VALID_CREATE_BODY }, 'idem-1', requestWithCtx());
    expect(response.campaign.id).toBe('cmp_1');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/ads/campaigns');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-1');
    // Defaults applied by the contract before forwarding.
    expect(stub.lastOptions?.body).toMatchObject({ status: 'draft', currency: 'USD' });
  });

  it('rejects a malformed body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_CAMPAIGN_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.create({ name: 'no advertiser kind' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects a provider campaign with a null advertiserId with 400', async () => {
    const stub = new StubDownstreamClient(ok(VALID_CAMPAIGN_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.create(
        { name: 'x', advertiserKind: 'provider', advertiserId: null },
        undefined,
        requestWithCtx(),
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards a downstream 422 (unsupported currency) verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 422,
      body: { type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail: 'USD only' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(
      controller.create({ ...VALID_CREATE_BODY }, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('AdminAdsCampaignsProxyController.detail', () => {
  it('forwards the GET and returns the full tree', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.detail('cmp_1', requestWithCtx());
    expect(response.campaign.creatives).toHaveLength(1);
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/ads/campaigns/cmp_1');
  });

  it('url-encodes the campaignId (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const controller = buildController(stub);
    await controller.detail('cmp/../admin', requestWithCtx());
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/ads/campaigns/cmp%2F..%2Fadmin');
  });

  it('maps a downstream 404 verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', status: 404, detail: 'no campaign' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(controller.detail('cmp_x', requestWithCtx())).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('AdminAdsCampaignsProxyController.update', () => {
  it('forwards the PATCH + body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(
      ok({ campaign: { ...CAMPAIGN, status: 'active' as const } }),
    );
    const controller = buildController(stub);
    const response = await controller.update(
      'cmp_1',
      { status: 'active' },
      'idem-2',
      requestWithCtx(),
    );
    expect(response.campaign.status).toBe('active');
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/ads/campaigns/cmp_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-2');
  });

  it('rejects an empty body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_CAMPAIGN_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.update('cmp_1', {}, undefined, requestWithCtx()),
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
      controller.update('cmp_1', { status: 'completed' }, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('maps a network_error to 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'ECONNREFUSED' });
    const controller = buildController(stub);
    await expect(
      controller.update('cmp_1', { name: 'x' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('AdminAdsCampaignsProxyController.updateCreativeStatus', () => {
  it('forwards the PATCH to the nested creative path + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_CREATIVE_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.updateCreativeStatus(
      'cmp_1',
      'crv_1',
      { status: 'pending_review' },
      'idem-3',
      requestWithCtx(),
    );
    expect(response.creative.status).toBe('pending_review');
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/ads/campaigns/cmp_1/creatives/crv_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-3');
  });

  it('rejects a malformed status with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_CREATIVE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.updateCreativeStatus(
        'cmp_1',
        'crv_1',
        { status: 'nope' },
        undefined,
        requestWithCtx(),
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('maps server_error to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 500,
      body: null,
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(
      controller.updateCreativeStatus(
        'cmp_1',
        'crv_1',
        { status: 'approved' },
        undefined,
        requestWithCtx(),
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
