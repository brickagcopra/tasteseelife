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

import { AdminAdsCreativesProxyController } from './admin-ads-creatives-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW = '2026-06-15T12:00:00.000Z';

function requestWithCtx(userId = 'usr_reviewer'): RequestWithContext {
  return {
    requestContext: {
      userId,
      mfaVerified: true,
      roles: [
        {
          name: 'marketing',
          permissions: ['ads:read', 'ads:write', 'marketing:approve_creative'],
          scope: { type: 'global' },
        },
      ],
      tenantScope: { type: 'global' },
    },
    headers: { 'x-trace-id': 'tr_crv_001', 'idempotency-key': 'idem_001' },
  } as unknown as RequestWithContext;
}

const REPORT = {
  passed: true,
  checks: [
    { id: 'alt_text_present', status: 'pass', detail: 'ok', contrastRatio: null },
    { id: 'contrast_ratio', status: 'pass', detail: 'ok', contrastRatio: 21 },
    { id: 'motion_safe', status: 'pass', detail: 'ok', contrastRatio: null },
    { id: 'disclosure_acknowledged', status: 'pass', detail: 'ok', contrastRatio: null },
  ],
};

const ITEM = {
  creative: {
    id: 'crv_1',
    campaignId: 'cmp_1',
    kind: 'banner' as const,
    assetKeys: [],
    headline: 'A warm chef-prepared meal',
    body: null,
    ctaUrl: null,
    status: 'pending_review' as const,
    createdAt: NOW,
    updatedAt: NOW,
  },
  accessibilityMetadata: {
    altText: 'A warm chef-prepared meal',
    textColor: '#000000',
    backgroundColor: '#ffffff',
    motionSafe: true,
    disclosureAcknowledged: true,
  },
  accessibility: REPORT,
  campaign: { id: 'cmp_1', name: 'Spring', advertiserKind: 'partner' as const },
};

const REVIEW = {
  id: 'rev_1',
  creativeId: 'crv_1',
  decision: 'approved' as const,
  reviewerUserId: 'usr_reviewer',
  notes: null,
  accessibilityPassed: true,
  overrodeAccessibility: false,
  accessibility: REPORT,
  createdAt: NOW,
};

const VALID_QUEUE_RESPONSE = { items: [ITEM] };
const VALID_DETAIL_RESPONSE = { item: ITEM, reviews: [REVIEW] };
const VALID_MUTATION_RESPONSE = { item: ITEM, review: REVIEW };
const VALID_ACCESSIBILITY_RESPONSE = { item: ITEM, review: null };

function buildController(stub: StubDownstreamClient): AdminAdsCreativesProxyController {
  return new AdminAdsCreativesProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminAdsCreativesProxyController.queue', () => {
  it('forwards the GET with an allow-listed query string', async () => {
    const stub = new StubDownstreamClient(ok(VALID_QUEUE_RESPONSE));
    const controller = buildController(stub);

    const response = await controller.queue({ limit: '25' }, requestWithCtx());

    expect(response.items).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('ads');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toContain('/api/v1/admin/ads/creatives/review-queue?');
    expect(stub.lastOptions?.path).toContain('limit=25');
    expect(stub.lastOptions?.traceId).toBe('tr_crv_001');
  });

  it('defaults the limit when no query is supplied', async () => {
    const stub = new StubDownstreamClient(ok(VALID_QUEUE_RESPONSE));
    const controller = buildController(stub);
    await controller.queue({}, requestWithCtx());
    expect(stub.lastOptions?.path).toContain('limit=50');
  });

  it('rejects a malformed query with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_QUEUE_RESPONSE));
    const controller = buildController(stub);
    await expect(controller.queue({ limit: '99999' }, requestWithCtx())).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(VALID_QUEUE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.queue({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws 502 when the downstream body violates the contract', async () => {
    const stub = new StubDownstreamClient(ok({ items: [{ bogus: true }] }));
    const controller = buildController(stub);
    await expect(controller.queue({}, requestWithCtx())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

describe('AdminAdsCreativesProxyController.detail', () => {
  it('forwards the GET to the review-detail path', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.detail('crv_1', requestWithCtx());
    expect(response.reviews).toHaveLength(1);
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/ads/creatives/crv_1/review');
  });

  it('url-encodes the creativeId (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const controller = buildController(stub);
    await controller.detail('../campaigns', requestWithCtx());
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/ads/creatives/..%2Fcampaigns/review');
  });

  it('passes a 404 through verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', status: 404, detail: 'gone' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(controller.detail('missing', requestWithCtx())).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('AdminAdsCreativesProxyController.updateAccessibility', () => {
  it('forwards the PATCH with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_ACCESSIBILITY_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.updateAccessibility(
      'crv_1',
      { altText: 'A warm meal', disclosureAcknowledged: true },
      'idem_001',
      requestWithCtx(),
    );
    expect(response.review).toBeNull();
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/ads/creatives/crv_1/accessibility');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_001');
  });

  it('rejects an empty patch with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_ACCESSIBILITY_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.updateAccessibility('crv_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects a malformed hex colour with 400', async () => {
    const stub = new StubDownstreamClient(ok(VALID_ACCESSIBILITY_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.updateAccessibility('crv_1', { textColor: 'red' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

describe('AdminAdsCreativesProxyController.review', () => {
  it('forwards the POST decision with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_MUTATION_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.review(
      'crv_1',
      { action: 'approve' },
      'idem_001',
      requestWithCtx(),
    );
    expect(response.review?.decision).toBe('approved');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/ads/creatives/crv_1/review');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_001');
  });

  it('rejects a reject-without-notes body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_MUTATION_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.review('crv_1', { action: 'reject' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('passes a 409 not-in-review through verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'not pending' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(
      controller.review('crv_1', { action: 'approve' }, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('passes a 422 accessibility failure through verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 422,
      body: { type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail: 'a11y' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(
      controller.review('crv_1', { action: 'approve' }, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('maps a downstream timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const controller = buildController(stub);
    await expect(
      controller.review('crv_1', { action: 'approve' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('maps a not_configured downstream to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'ads' });
    const controller = buildController(stub);
    await expect(
      controller.review('crv_1', { action: 'approve' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('maps a network_error downstream to 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'ECONNREFUSED' });
    const controller = buildController(stub);
    await expect(
      controller.review('crv_1', { action: 'approve' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
