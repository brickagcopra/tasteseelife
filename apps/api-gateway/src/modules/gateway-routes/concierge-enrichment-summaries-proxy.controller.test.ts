import {
  BadGatewayException,
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

import { ConciergeEnrichmentSummariesProxyController } from './concierge-enrichment-summaries-proxy.controller';

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

function householdRequest(householdId = 'hh_1', userId = 'usr_family'): RequestWithContext {
  return {
    requestContext: {
      userId,
      mfaVerified: true,
      roles: [],
      tenantScope: { type: 'household', householdId },
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
  status: 'published' as const,
  headline: 'A warm week',
  visitHighlights: 'Two visits.',
  wellnessSignals: 'Steady.',
  socialEngagement: 'Tea social.',
  additionalNotes: null,
  authoredByUserId: 'usr_ops',
  publishedAt: NOW,
  publishedByUserId: 'usr_ops',
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function buildController(stub: StubDownstreamClient): ConciergeEnrichmentSummariesProxyController {
  return new ConciergeEnrichmentSummariesProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('ConciergeEnrichmentSummariesProxyController.listMine', () => {
  it('forwards the GET /me with an allow-listed limit', async () => {
    const stub = new StubDownstreamClient(ok({ householdId: 'hh_1', summaries: [RECORD] }));
    const response = await buildController(stub).listMine({ limit: '12' }, householdRequest());
    expect(response.summaries).toHaveLength(1);
    expect(stub.lastOptions?.path).toContain('/api/v1/concierge/enrichment-summaries/me?');
    expect(stub.lastOptions?.path).toContain('limit=12');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.traceId).toBe('tr_test_001');
  });

  it('defaults the limit when absent', async () => {
    const stub = new StubDownstreamClient(ok({ householdId: 'hh_1', summaries: [] }));
    await buildController(stub).listMine({}, householdRequest());
    expect(stub.lastOptions?.path).toContain('limit=26');
  });

  it('rejects a limit over the max at the gateway (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok({ householdId: 'hh_1', summaries: [] }));
    await expect(
      buildController(stub).listMine({ limit: '9999' }, householdRequest()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 with no context', async () => {
    const stub = new StubDownstreamClient(ok({ householdId: 'hh_1', summaries: [] }));
    await expect(buildController(stub).listMine({}, requestWithoutCtx())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('forwards a downstream 400 (non-household actor) verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 400,
      body: { type: 'about:blank', title: 'Bad Request', status: 400, detail: 'household only' },
      setCookies: [],
    });
    await expect(buildController(stub).listMine({}, householdRequest())).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('ConciergeEnrichmentSummariesProxyController.getMine', () => {
  it('forwards the permalink GET by id', async () => {
    const stub = new StubDownstreamClient(ok({ householdId: 'hh_1', summary: RECORD }));
    const response = await buildController(stub).getMine('sum_7', householdRequest());
    expect(response.summary?.id).toBe('sum_1');
    expect(stub.lastOptions?.path).toBe('/api/v1/concierge/enrichment-summaries/me/sum_7');
  });

  it('passes through a null summary (permalink miss)', async () => {
    const stub = new StubDownstreamClient(ok({ householdId: 'hh_1', summary: null }));
    const response = await buildController(stub).getMine('sum_missing', householdRequest());
    expect(response.summary).toBeNull();
  });

  it('URL-encodes a slash-injection id', async () => {
    const stub = new StubDownstreamClient(ok({ householdId: 'hh_1', summary: null }));
    await buildController(stub).getMine('a/../b', householdRequest());
    expect(stub.lastOptions?.path).toBe('/api/v1/concierge/enrichment-summaries/me/a%2F..%2Fb');
  });

  it('maps a contract-violating body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ householdId: 'hh_1', summary: { id: 'x' } }));
    await expect(buildController(stub).getMine('sum_1', householdRequest())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps a downstream not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'concierge' });
    await expect(buildController(stub).getMine('sum_1', householdRequest())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
