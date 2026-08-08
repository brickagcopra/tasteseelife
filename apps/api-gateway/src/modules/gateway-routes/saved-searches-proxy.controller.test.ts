import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { SavedSearch } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { SavedSearchesProxyController } from './saved-searches-proxy.controller';

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
    userId: 'usr_abc',
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_001' },
} as unknown as RequestWithContext;

const SAMPLE_SAVED: SavedSearch = {
  id: 'ss_abc',
  ownerUserId: 'usr_abc',
  seniorId: 'senior_mom',
  name: 'Italian chefs',
  query: { sort: 'relevance', limit: 20 },
  lastRunAt: null,
  createdAt: '2026-05-21T12:00:00.000Z',
  updatedAt: '2026-05-21T12:00:00.000Z',
};

function makeController(result: DownstreamResult): {
  controller: SavedSearchesProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  const controller = new SavedSearchesProxyController(stub as unknown as DownstreamHttpClient);
  return { controller, stub };
}

describe('SavedSearchesProxyController.list', () => {
  it('forwards to service-search and returns the list', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { savedSearches: [SAMPLE_SAVED] },
      setCookies: [],
    });
    const response = await controller.list(REQUEST_WITH_CTX);
    expect(response.savedSearches).toEqual([SAMPLE_SAVED]);
    expect(stub.lastOptions?.service).toBe('search');
    expect(stub.lastOptions?.path).toBe('/api/v1/saved-searches');
    expect(stub.lastOptions?.method).toBe('GET');
  });

  it('throws Unauthorized when no requestContext', async () => {
    const { controller } = makeController({
      kind: 'ok',
      status: 200,
      body: { savedSearches: [] },
      setCookies: [],
    });
    await expect(
      controller.list({ headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps 503 not_configured to ServiceUnavailable', async () => {
    const { controller } = makeController({ kind: 'not_configured', service: 'search' });
    await expect(controller.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps timeout to 504', async () => {
    const { controller } = makeController({ kind: 'timeout' });
    await expect(controller.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('maps network_error to 502', async () => {
    const { controller } = makeController({ kind: 'network_error', detail: 'enotfound' });
    await expect(controller.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a malformed ok body to 502', async () => {
    const { controller } = makeController({
      kind: 'ok',
      status: 200,
      body: { not_what_we_expected: true },
      setCookies: [],
    });
    await expect(controller.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('SavedSearchesProxyController.get (TS-215-followup-1)', () => {
  it('forwards to service-search and returns the wrapped row', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { savedSearch: SAMPLE_SAVED },
      setCookies: [],
    });
    const response = await controller.get('ss_abc', REQUEST_WITH_CTX);
    expect(response.savedSearch).toEqual(SAMPLE_SAVED);
    expect(stub.lastOptions?.service).toBe('search');
    expect(stub.lastOptions?.path).toBe('/api/v1/saved-searches/ss_abc');
    expect(stub.lastOptions?.method).toBe('GET');
  });

  it('URL-encodes the id to defeat slash injection', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { savedSearch: SAMPLE_SAVED },
      setCookies: [],
    });
    await controller.get('ss/with slash', REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/saved-searches/ss%2Fwith%20slash');
  });

  it('throws Unauthorized when no requestContext', async () => {
    const { controller } = makeController({
      kind: 'ok',
      status: 200,
      body: { savedSearch: SAMPLE_SAVED },
      setCookies: [],
    });
    await expect(
      controller.get('ss_abc', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('re-throws downstream 404 verbatim (missing or non-owner)', async () => {
    const { controller } = makeController({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', detail: 'gone' },
      setCookies: [],
    });
    await expect(controller.get('ss_missing', REQUEST_WITH_CTX)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('maps timeout to 504', async () => {
    const { controller } = makeController({ kind: 'timeout' });
    await expect(controller.get('ss_abc', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('maps network_error to 502', async () => {
    const { controller } = makeController({ kind: 'network_error', detail: 'enotfound' });
    await expect(controller.get('ss_abc', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps not_configured to 503', async () => {
    const { controller } = makeController({ kind: 'not_configured', service: 'search' });
    await expect(controller.get('ss_abc', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps a malformed ok body to 502 (contract violation)', async () => {
    const { controller } = makeController({
      kind: 'ok',
      status: 200,
      body: { not_what_we_expected: true },
      setCookies: [],
    });
    await expect(controller.get('ss_abc', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

describe('SavedSearchesProxyController.create', () => {
  it('forwards the validated body and returns the row', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 201,
      body: SAMPLE_SAVED,
      setCookies: [],
    });
    const response = await controller.create(
      { name: 'Italian chefs', query: { sort: 'relevance', limit: 20 } },
      REQUEST_WITH_CTX,
    );
    expect(response).toEqual(SAMPLE_SAVED);
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.body).toMatchObject({ name: 'Italian chefs' });
  });

  it('rejects a missing name with 400', async () => {
    const { controller } = makeController({
      kind: 'ok',
      status: 201,
      body: SAMPLE_SAVED,
      setCookies: [],
    });
    await expect(
      controller.create({ query: { sort: 'relevance', limit: 20 } }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('re-throws downstream client errors verbatim (e.g. 409 from quota)', async () => {
    const { controller } = makeController({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', detail: 'quota' },
      setCookies: [],
    });
    await expect(
      controller.create({ name: 'X', query: { sort: 'relevance', limit: 20 } }, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('SavedSearchesProxyController.update', () => {
  it('forwards the PATCH and URL-encodes the id', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_SAVED,
      setCookies: [],
    });
    await controller.update('ss/with slash', { name: 'X' }, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/saved-searches/ss%2Fwith%20slash');
    expect(stub.lastOptions?.method).toBe('PATCH');
  });

  it('rejects an unknown patch field with 400 (strict)', async () => {
    const { controller } = makeController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_SAVED,
      setCookies: [],
    });
    await expect(
      controller.update('ss_abc', { smuggled: 1 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });
});

describe('SavedSearchesProxyController.run', () => {
  it('forwards the run and returns the refreshed shape', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { savedSearch: { ...SAMPLE_SAVED, lastRunAt: '2026-05-21T13:00:00.000Z' } },
      setCookies: [],
    });
    const response = await controller.run('ss_abc', REQUEST_WITH_CTX);
    expect(response.savedSearch.lastRunAt).toBe('2026-05-21T13:00:00.000Z');
    expect(stub.lastOptions?.path).toBe('/api/v1/saved-searches/ss_abc/run');
    expect(stub.lastOptions?.method).toBe('POST');
  });
});

describe('SavedSearchesProxyController.delete', () => {
  it('forwards the delete and returns the outcome', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { outcome: 'deleted', id: 'ss_abc' },
      setCookies: [],
    });
    const response = await controller.delete('ss_abc', REQUEST_WITH_CTX);
    expect(response).toEqual({ outcome: 'deleted', id: 'ss_abc' });
    expect(stub.lastOptions?.path).toBe('/api/v1/saved-searches/ss_abc');
    expect(stub.lastOptions?.method).toBe('DELETE');
  });

  it('returns not_found on idempotent replay', async () => {
    const { controller } = makeController({
      kind: 'ok',
      status: 200,
      body: { outcome: 'not_found', id: 'ss_abc' },
      setCookies: [],
    });
    const response = await controller.delete('ss_abc', REQUEST_WITH_CTX);
    expect(response.outcome).toBe('not_found');
  });
});
