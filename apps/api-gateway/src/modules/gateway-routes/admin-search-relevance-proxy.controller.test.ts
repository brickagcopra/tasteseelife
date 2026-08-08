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

import { AdminSearchRelevanceProxyController } from './admin-search-relevance-proxy.controller';

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
    userId: 'usr_admin',
    mfaVerified: true,
    roles: [{ name: 'super_admin', permissions: [], scope: { type: 'global' } }],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_001' },
} as unknown as RequestWithContext;

const SUMMARY = {
  metricDate: '2026-06-08',
  totalSearches: 120,
  zeroResultSearches: 18,
  distinctSearchers: 40,
  bookingsCreated: 6,
  attributedBookings: 4,
  zeroResultRatePpm: 150_000,
  approxConversionPpm: 150_000,
  attributedConversionPpm: 33_333,
  computedAt: '2026-06-09T03:00:00.000Z',
};

const VALID_SUMMARY_RESPONSE = { summaries: [SUMMARY], from: '2026-06-08', to: '2026-06-08' };

const VALID_DETAIL_RESPONSE = {
  metricDate: '2026-06-08',
  summary: SUMMARY,
  topQueries: [{ queryText: 'kosher chef', searchCount: 30, zeroResultCount: 2 }],
  zeroResultQueries: [{ queryText: 'vegan sushi', searchCount: 5, zeroResultCount: 5 }],
  sortBreakdown: [{ sort: 'relevance', searchCount: 100, zeroResultCount: 12 }],
  clickPositions: [{ position: 0, clickCount: 40, impressionCount: 120, ctrPpm: 333_333 }],
};

function okStub(body: unknown): StubDownstreamClient {
  return new StubDownstreamClient({ kind: 'ok', status: 200, body, setCookies: [] });
}

describe('AdminSearchRelevanceProxyController.listSummaries', () => {
  it('returns the response unchanged on success and targets analytics', async () => {
    const stub = okStub(VALID_SUMMARY_RESPONSE);
    const c = new AdminSearchRelevanceProxyController(stub as unknown as DownstreamHttpClient);
    const response = await c.listSummaries({}, REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_SUMMARY_RESPONSE);
    expect(stub.lastOptions?.service).toBe('analytics');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/analytics/search-relevance/summary');
  });

  it('forwards the from/to bounds to the downstream path', async () => {
    const stub = okStub(VALID_SUMMARY_RESPONSE);
    const c = new AdminSearchRelevanceProxyController(stub as unknown as DownstreamHttpClient);
    await c.listSummaries({ from: '2026-06-01', to: '2026-06-08' }, REQUEST_WITH_CTX);
    const url = stub.lastOptions?.path ?? '';
    expect(url).toContain('from=2026-06-01');
    expect(url).toContain('to=2026-06-08');
  });

  it('rejects unknown query fields (strict) with 400', async () => {
    const c = new AdminSearchRelevanceProxyController(
      okStub(VALID_SUMMARY_RESPONSE) as unknown as DownstreamHttpClient,
    );
    await expect(c.listSummaries({ window: '90d' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('rejects a from-after-to range with 400', async () => {
    const c = new AdminSearchRelevanceProxyController(
      okStub(VALID_SUMMARY_RESPONSE) as unknown as DownstreamHttpClient,
    );
    await expect(
      c.listSummaries({ from: '2026-06-08', to: '2026-06-01' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 401 without a RequestContext', async () => {
    const c = new AdminSearchRelevanceProxyController(
      okStub(VALID_SUMMARY_RESPONSE) as unknown as DownstreamHttpClient,
    );
    await expect(
      c.listSummaries({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps downstream failure modes to 504 / 502 / 503 / 502', async () => {
    const cases: readonly { result: DownstreamResult; ctor: Function }[] = [
      { result: { kind: 'timeout' }, ctor: GatewayTimeoutException },
      { result: { kind: 'network_error', detail: 'refused' }, ctor: BadGatewayException },
      {
        result: { kind: 'not_configured', service: 'analytics' },
        ctor: ServiceUnavailableException,
      },
      {
        result: { kind: 'server_error', status: 500, body: {}, setCookies: [] },
        ctor: BadGatewayException,
      },
    ];
    for (const { result, ctor } of cases) {
      const stub = new StubDownstreamClient(result);
      const c = new AdminSearchRelevanceProxyController(stub as unknown as DownstreamHttpClient);
      await expect(c.listSummaries({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(ctor);
    }
  });

  it('returns 502 on a contract-violating 200 body', async () => {
    const c = new AdminSearchRelevanceProxyController(
      okStub({
        summaries: [{ malformed: true }],
        from: null,
        to: null,
      }) as unknown as DownstreamHttpClient,
    );
    await expect(c.listSummaries({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('AdminSearchRelevanceProxyController.getDetail', () => {
  it('returns the detail unchanged and forwards the date', async () => {
    const stub = okStub(VALID_DETAIL_RESPONSE);
    const c = new AdminSearchRelevanceProxyController(stub as unknown as DownstreamHttpClient);
    const response = await c.getDetail({ date: '2026-06-08' }, REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_DETAIL_RESPONSE);
    expect(stub.lastOptions?.service).toBe('analytics');
    expect(stub.lastOptions?.path).toBe(
      '/api/v1/admin/analytics/search-relevance/detail?date=2026-06-08',
    );
  });

  it('rejects a missing date with 400', async () => {
    const c = new AdminSearchRelevanceProxyController(
      okStub(VALID_DETAIL_RESPONSE) as unknown as DownstreamHttpClient,
    );
    await expect(c.getDetail({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects a datetime date (must be a calendar date) with 400', async () => {
    const c = new AdminSearchRelevanceProxyController(
      okStub(VALID_DETAIL_RESPONSE) as unknown as DownstreamHttpClient,
    );
    await expect(
      c.getDetail({ date: '2026-06-08T00:00:00.000Z' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('returns 502 on a contract-violating detail body', async () => {
    const c = new AdminSearchRelevanceProxyController(
      okStub({
        metricDate: '2026-06-08',
        summary: null,
        topQueries: [{ bad: 1 }],
      }) as unknown as DownstreamHttpClient,
    );
    await expect(c.getDetail({ date: '2026-06-08' }, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
