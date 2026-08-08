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

import { AdminConciergeEnrichmentSummariesProxyController } from './admin-concierge-enrichment-summaries-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW = '2026-05-26T15:00:00.000Z';
const MONDAY = '2026-05-25';

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

function requestWithoutCtx(): RequestWithContext {
  return { headers: {} } as unknown as RequestWithContext;
}

const RECORD = {
  id: 'sum_1',
  householdId: 'hh_1',
  weekStartDate: MONDAY,
  status: 'draft' as const,
  headline: 'A warm week',
  visitHighlights: 'Two visits.',
  wellnessSignals: 'Steady.',
  socialEngagement: 'Tea social.',
  additionalNotes: null,
  authoredByUserId: 'usr_ops',
  publishedAt: null,
  publishedByUserId: null,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const VALID_LIST_RESPONSE = { summaries: [RECORD] };
const VALID_DETAIL_RESPONSE = { summary: RECORD };

const VALID_CREATE_BODY = {
  householdId: 'hh_9',
  weekStartDate: MONDAY,
  headline: 'Hi',
  visitHighlights: 'v',
  wellnessSignals: 'w',
  socialEngagement: 's',
};

function buildController(
  stub: StubDownstreamClient,
): AdminConciergeEnrichmentSummariesProxyController {
  return new AdminConciergeEnrichmentSummariesProxyController(
    stub as unknown as DownstreamHttpClient,
  );
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminConciergeEnrichmentSummariesProxyController.list', () => {
  it('forwards the GET with an allow-listed query string', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const response = await buildController(stub).list(
      { householdId: 'hh_9', status: 'published', limit: '10' },
      requestWithCtx(),
    );
    expect(response.summaries).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('concierge');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toContain('/api/v1/admin/concierge/enrichment-summaries?');
    expect(stub.lastOptions?.path).toContain('householdId=hh_9');
    expect(stub.lastOptions?.path).toContain('status=published');
    expect(stub.lastOptions?.path).toContain('limit=10');
    expect(stub.lastOptions?.traceId).toBe('tr_test_001');
  });

  it('defaults the limit when no query is supplied', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    await buildController(stub).list({}, requestWithCtx());
    expect(stub.lastOptions?.path).toContain('limit=26');
  });

  it('rejects a malformed query with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    await expect(
      buildController(stub).list({ status: 'nope' }, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when the request carries no context', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    await expect(buildController(stub).list({}, requestWithoutCtx())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('AdminConciergeEnrichmentSummariesProxyController.create', () => {
  it('forwards the validated body, actor, and idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const response = await buildController(stub).create(
      VALID_CREATE_BODY,
      'idem-1',
      requestWithCtx(),
    );
    expect(response.summary.id).toBe('sum_1');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/concierge/enrichment-summaries');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-1');
    expect(stub.lastOptions?.body).toMatchObject({ householdId: 'hh_9', weekStartDate: MONDAY });
  });

  it('rejects a non-Monday weekStartDate at the gateway (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    await expect(
      buildController(stub).create(
        { ...VALID_CREATE_BODY, weekStartDate: '2026-05-26' },
        undefined,
        requestWithCtx(),
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards a downstream 409 verbatim (week already taken)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'week taken' },
      setCookies: [],
    });
    await expect(
      buildController(stub).create(VALID_CREATE_BODY, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('AdminConciergeEnrichmentSummariesProxyController.get', () => {
  it('forwards the GET by id', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const response = await buildController(stub).get('sum_1', requestWithCtx());
    expect(response.summary.id).toBe('sum_1');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/concierge/enrichment-summaries/sum_1');
  });

  it('URL-encodes a slash-injection id', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    await buildController(stub).get('sum/../admin', requestWithCtx());
    expect(stub.lastOptions?.path).toBe(
      '/api/v1/admin/concierge/enrichment-summaries/sum%2F..%2Fadmin',
    );
  });

  it('maps a downstream server_error to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 500,
      body: null,
      setCookies: [],
    });
    await expect(buildController(stub).get('sum_1', requestWithCtx())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

describe('AdminConciergeEnrichmentSummariesProxyController.update', () => {
  it('forwards the validated body + idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    await buildController(stub).update(
      'sum_1',
      { status: 'published', headline: 'Revised' },
      'idem-2',
      requestWithCtx(),
    );
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/concierge/enrichment-summaries/sum_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-2');
    expect(stub.lastOptions?.body).toMatchObject({ status: 'published', headline: 'Revised' });
  });

  it('rejects an empty update body at the gateway (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    await expect(
      buildController(stub).update('sum_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('maps a downstream timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    await expect(
      buildController(stub).update('sum_1', { status: 'archived' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('maps a downstream not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'concierge' });
    await expect(
      buildController(stub).update('sum_1', { status: 'archived' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
