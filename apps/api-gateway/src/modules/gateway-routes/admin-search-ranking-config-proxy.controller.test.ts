import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import type { Env } from '../../config/env';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { AdminSearchRankingConfigProxyController } from './admin-search-ranking-config-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW_ISO = '2026-05-21T12:00:00.000Z';

const REQUEST_WITH_CTX: RequestWithContext = {
  requestContext: {
    userId: 'usr_admin',
    mfaVerified: true,
    roles: [{ name: 'super_admin', permissions: [], scope: { type: 'global' } }],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_001' },
} as unknown as RequestWithContext;

const CONFIG_GLOBAL = {
  id: 'rnk_global',
  regionCode: 'global',
  description: null,
  tierWeightBasic: 1.0,
  tierWeightCertified: 1.2,
  tierWeightElite: 1.5,
  updatedByUserId: null,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const CONFIG_NYC = {
  id: 'rnk_nyc',
  regionCode: 'nyc',
  description: 'NYC weights — boost Certified for Manhattan demand',
  tierWeightBasic: 0.9,
  tierWeightCertified: 1.4,
  tierWeightElite: 1.6,
  updatedByUserId: 'usr_admin',
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const VALID_LIST_RESPONSE = {
  configs: [CONFIG_GLOBAL, CONFIG_NYC],
};

const VALID_GET_FOUND_RESPONSE = {
  kind: 'found' as const,
  config: CONFIG_GLOBAL,
};

const VALID_GET_NOT_FOUND_RESPONSE = {
  kind: 'not_found' as const,
  regionCode: 'unknown',
};

const VALID_UPSERT_RESPONSE = {
  outcome: 'updated' as const,
  config: CONFIG_NYC,
};

const VALID_DELETE_RESPONSE = {
  outcome: 'deleted' as const,
  regionCode: 'nyc',
};

/**
 * Default env stub — secret present so the proxy doesn't short-circuit
 * with 503. Override per-test by spreading + flipping the key.
 */
const ENV: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  LOG_LEVEL: 'info',
  SERVICE_VERSION: 'dev',
  OTEL_TRACES_ENABLED: false,
  OTEL_METRICS_ENABLED: false,
  JWT_ACCESS_SECRET: 'j'.repeat(32),
  JWT_ISSUER: 'taste-and-see/service-identity',
  JWT_AUDIENCE: 'taste-and-see/api',
  INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
  INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
  REDIS_URL: 'redis://localhost:6379',
  RATE_LIMIT_DEFAULT_WINDOW_SECONDS: 60,
  RATE_LIMIT_DEFAULT_MAX_REQUESTS: 120,
  RATE_LIMIT_SENSITIVE_WINDOW_SECONDS: 300,
  RATE_LIMIT_SENSITIVE_MAX_REQUESTS: 20,
  DOWNSTREAM_REQUEST_TIMEOUT_MS: 5_000,
  SUBSCRIPTION_SERVICE_BASE_URL: 'http://service-subscription.local',
  HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME: 'x-household-visit-prep-internal-api-key',
  HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: 'x-household-memberships-internal-api-key',
  HOUSEHOLD_SCOPE_CACHE_TTL_SECONDS: 60,
  SEARCH_INDEX_HEADER_NAME: 'x-internal-api-key',
  SEARCH_INDEX_API_KEY: 's'.repeat(32),
} as Env;

function buildController(
  stub: StubDownstreamClient,
  env: Env = ENV,
): AdminSearchRankingConfigProxyController {
  return new AdminSearchRankingConfigProxyController(stub as unknown as DownstreamHttpClient, env);
}

// ─────────────────────────────────────────────────────────────────────
// list()
// ─────────────────────────────────────────────────────────────────────

describe('AdminSearchRankingConfigProxyController.list', () => {
  it('returns the parsed list response + forwards shared-secret + actor', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.list(REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_LIST_RESPONSE);
    expect(stub.lastOptions?.service).toBe('search');
    expect(stub.lastOptions?.path).toBe('/api/v1/internal/search/ranking-config');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_admin');
    expect(stub.lastOptions?.extraHeaders).toEqual({
      'x-internal-api-key': 's'.repeat(32),
    });
  });

  it('throws 503 when SEARCH_INDEX_API_KEY is unset', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const envWithoutSecret: Env = { ...ENV, SEARCH_INDEX_API_KEY: undefined };
    const c = buildController(stub, envWithoutSecret);

    await expect(c.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LIST_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.list({ headers: {} } as unknown as RequestWithContext)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('translates downstream timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = buildController(stub);

    await expect(c.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('translates downstream network_error to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'network_error',
      detail: 'connection refused',
    });
    const c = buildController(stub);

    await expect(c.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('translates downstream server_error to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 500,
      body: null,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('translates not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'search' });
    const c = buildController(stub);

    await expect(c.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('forwards a downstream 4xx verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Internal authentication required.',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 401,
      body: downstreamBody,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.list(REQUEST_WITH_CTX)).rejects.toMatchObject({
      status: 401,
      response: downstreamBody,
    });
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { totally: 'wrong' },
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });
});

// ─────────────────────────────────────────────────────────────────────
// getByRegion()
// ─────────────────────────────────────────────────────────────────────

describe('AdminSearchRankingConfigProxyController.getByRegion', () => {
  it('forwards the encoded regionCode and returns the found response', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_GET_FOUND_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.getByRegion('global', REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_GET_FOUND_RESPONSE);
    expect(stub.lastOptions?.path).toBe('/api/v1/internal/search/ranking-config/global');
  });

  it('passes through the not_found discriminated variant', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_GET_NOT_FOUND_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.getByRegion('unknown', REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_GET_NOT_FOUND_RESPONSE);
  });

  it('rejects an uppercase regionCode at the gateway (defence-in-depth)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_GET_FOUND_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.getByRegion('NYC', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects a slash-injection regionCode at the gateway', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_GET_FOUND_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.getByRegion('nyc/../global', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 503 when SEARCH_INDEX_API_KEY is unset', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_GET_FOUND_RESPONSE,
      setCookies: [],
    });
    const envWithoutSecret: Env = { ...ENV, SEARCH_INDEX_API_KEY: undefined };
    const c = buildController(stub, envWithoutSecret);

    await expect(c.getByRegion('global', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_GET_FOUND_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.getByRegion('global', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ─────────────────────────────────────────────────────────────────────
// upsertByRegion()
// ─────────────────────────────────────────────────────────────────────

describe('AdminSearchRankingConfigProxyController.upsertByRegion', () => {
  const VALID_BODY = {
    description: 'NYC',
    tierWeightBasic: 0.9,
    tierWeightCertified: 1.4,
    tierWeightElite: 1.6,
  };

  it('forwards the body, stamps actor.userId into updatedByUserId, and forwards the idempotency key', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPSERT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.upsertByRegion(
      'nyc',
      VALID_BODY,
      'ranking-config-upsert-001',
      REQUEST_WITH_CTX,
    );
    expect(response).toEqual(VALID_UPSERT_RESPONSE);
    expect(stub.lastOptions?.method).toBe('PUT');
    expect(stub.lastOptions?.path).toBe('/api/v1/internal/search/ranking-config/nyc');
    expect(stub.lastOptions?.body).toEqual({
      ...VALID_BODY,
      updatedByUserId: 'usr_admin',
    });
    expect(stub.lastOptions?.idempotencyKey).toBe('ranking-config-upsert-001');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_admin');
    expect(stub.lastOptions?.extraHeaders).toEqual({
      'x-internal-api-key': 's'.repeat(32),
    });
  });

  it('overrides a caller-supplied updatedByUserId with the authenticated actor', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPSERT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.upsertByRegion(
      'nyc',
      { ...VALID_BODY, updatedByUserId: 'usr_smuggled' },
      undefined,
      REQUEST_WITH_CTX,
    );
    expect(stub.lastOptions?.body).toMatchObject({ updatedByUserId: 'usr_admin' });
  });

  it('omits Idempotency-Key when the inbound header is absent', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPSERT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.upsertByRegion('nyc', VALID_BODY, undefined, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });

  it('rejects an unknown body field (strict)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPSERT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.upsertByRegion('nyc', { ...VALID_BODY, smuggled: 'oops' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects an out-of-range tier weight', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPSERT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.upsertByRegion('nyc', { ...VALID_BODY, tierWeightElite: 99 }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects a malformed regionCode at the gateway', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPSERT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.upsertByRegion('Mixed_Case', VALID_BODY, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 503 when SEARCH_INDEX_API_KEY is unset', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPSERT_RESPONSE,
      setCookies: [],
    });
    const envWithoutSecret: Env = { ...ENV, SEARCH_INDEX_API_KEY: undefined };
    const c = buildController(stub, envWithoutSecret);

    await expect(
      c.upsertByRegion('nyc', VALID_BODY, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPSERT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.upsertByRegion('nyc', VALID_BODY, undefined, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('forwards a downstream 422 (global_protected via DELETE; here a hypothetical 422) verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Unprocessable Entity',
      status: 422,
      detail: 'something failed downstream',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 422,
      body: downstreamBody,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.upsertByRegion('nyc', VALID_BODY, undefined, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 422, response: downstreamBody });
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { totally: 'wrong' },
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.upsertByRegion('nyc', VALID_BODY, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

// ─────────────────────────────────────────────────────────────────────
// deleteByRegion()
// ─────────────────────────────────────────────────────────────────────

describe('AdminSearchRankingConfigProxyController.deleteByRegion', () => {
  it('forwards the regionCode and returns the deleted outcome', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DELETE_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.deleteByRegion('nyc', REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_DELETE_RESPONSE);
    expect(stub.lastOptions?.method).toBe('DELETE');
    expect(stub.lastOptions?.path).toBe('/api/v1/internal/search/ranking-config/nyc');
  });

  it('forwards a downstream 422 (global_protected) verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Unprocessable Entity',
      status: 422,
      detail:
        'The "global" row cannot be deleted — it is the load-bearing fallback for every region.',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 422,
      body: downstreamBody,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.deleteByRegion('global', REQUEST_WITH_CTX)).rejects.toMatchObject({
      status: 422,
      response: downstreamBody,
    });
  });

  it('forwards a downstream 404 verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'No ranking-config row for regionCode "unknown".',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: downstreamBody,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.deleteByRegion('unknown', REQUEST_WITH_CTX)).rejects.toMatchObject({
      status: 404,
      response: downstreamBody,
    });
  });

  it('rejects a malformed regionCode at the gateway', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DELETE_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.deleteByRegion('nyc/../global', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 503 when SEARCH_INDEX_API_KEY is unset', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DELETE_RESPONSE,
      setCookies: [],
    });
    const envWithoutSecret: Env = { ...ENV, SEARCH_INDEX_API_KEY: undefined };
    const c = buildController(stub, envWithoutSecret);

    await expect(c.deleteByRegion('nyc', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DELETE_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.deleteByRegion('nyc', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
