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

import { AdminFeaturedPlacementsProxyController } from './admin-featured-placements-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW_ISO = '2026-06-01T09:00:00.000Z';
const END_ISO = '2026-06-08T09:00:00.000Z';

const REQUEST_WITH_CTX: RequestWithContext = {
  requestContext: {
    userId: 'usr_admin',
    mfaVerified: true,
    roles: [{ name: 'super_admin', permissions: [], scope: { type: 'global' } }],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_207' },
} as unknown as RequestWithContext;

const PLACEMENT = {
  id: 'fp_abc',
  providerId: 'prov_abc',
  regionCode: null,
  tier: null,
  boostMultiplier: 2,
  startsAt: NOW_ISO,
  endsAt: END_ISO,
  note: null,
  createdByUserId: 'usr_admin',
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const VALID_LIST_RESPONSE = { placements: [PLACEMENT] };
const VALID_SCHEDULE_RESPONSE = { placement: PLACEMENT };
const VALID_DELETE_RESPONSE = { outcome: 'deleted' as const, placementId: 'fp_abc' };

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
): AdminFeaturedPlacementsProxyController {
  return new AdminFeaturedPlacementsProxyController(stub as unknown as DownstreamHttpClient, env);
}

function okStub(body: unknown): StubDownstreamClient {
  return new StubDownstreamClient({ kind: 'ok', status: 200, body, setCookies: [] });
}

// ─────────────────────────────────────────────────────────────────────
// list()
// ─────────────────────────────────────────────────────────────────────

describe('AdminFeaturedPlacementsProxyController.list', () => {
  it('returns the parsed list + forwards shared-secret + actor + allow-listed query', async () => {
    const stub = okStub(VALID_LIST_RESPONSE);
    const response = await buildController(stub).list(
      { providerId: 'prov_abc', activeOnly: 'true', limit: '25' },
      REQUEST_WITH_CTX,
    );
    expect(response).toEqual(VALID_LIST_RESPONSE);
    expect(stub.lastOptions?.service).toBe('search');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toBe(
      '/api/v1/internal/search/featured-placements?limit=25&providerId=prov_abc&activeOnly=true',
    );
    expect(stub.lastOptions?.actor?.userId).toBe('usr_admin');
    expect(stub.lastOptions?.extraHeaders).toEqual({ 'x-internal-api-key': 's'.repeat(32) });
  });

  it('defaults the limit when no query params are supplied', async () => {
    const stub = okStub(VALID_LIST_RESPONSE);
    await buildController(stub).list({}, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/internal/search/featured-placements?limit=50');
  });

  it('rejects a limit over the cap at the gateway', async () => {
    const stub = okStub(VALID_LIST_RESPONSE);
    await expect(
      buildController(stub).list({ limit: '9999' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 503 when SEARCH_INDEX_API_KEY is unset', async () => {
    const stub = okStub(VALID_LIST_RESPONSE);
    await expect(
      buildController(stub, { ...ENV, SEARCH_INDEX_API_KEY: undefined }).list({}, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = okStub(VALID_LIST_RESPONSE);
    await expect(
      buildController(stub).list({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('translates downstream timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    await expect(buildController(stub).list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = okStub({ totally: 'wrong' });
    await expect(buildController(stub).list({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// schedule()
// ─────────────────────────────────────────────────────────────────────

describe('AdminFeaturedPlacementsProxyController.schedule', () => {
  const VALID_BODY = {
    providerId: 'prov_abc',
    boostMultiplier: 2,
    startsAt: NOW_ISO,
    endsAt: END_ISO,
  };

  it('forwards the body, stamps actor.userId into createdByUserId, forwards the idempotency key', async () => {
    const stub = okStub(VALID_SCHEDULE_RESPONSE);
    const response = await buildController(stub).schedule(
      VALID_BODY,
      'featured-schedule-001',
      REQUEST_WITH_CTX,
    );
    expect(response).toEqual(VALID_SCHEDULE_RESPONSE);
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/internal/search/featured-placements');
    expect(stub.lastOptions?.body).toMatchObject({
      providerId: 'prov_abc',
      boostMultiplier: 2,
      createdByUserId: 'usr_admin',
    });
    expect(stub.lastOptions?.idempotencyKey).toBe('featured-schedule-001');
  });

  it('overrides a caller-supplied createdByUserId with the authenticated actor', async () => {
    const stub = okStub(VALID_SCHEDULE_RESPONSE);
    await buildController(stub).schedule(
      { ...VALID_BODY, createdByUserId: 'usr_smuggled' },
      undefined,
      REQUEST_WITH_CTX,
    );
    expect(stub.lastOptions?.body).toMatchObject({ createdByUserId: 'usr_admin' });
  });

  it('omits Idempotency-Key when the inbound header is absent', async () => {
    const stub = okStub(VALID_SCHEDULE_RESPONSE);
    await buildController(stub).schedule(VALID_BODY, undefined, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });

  it('rejects an unknown body field (strict)', async () => {
    const stub = okStub(VALID_SCHEDULE_RESPONSE);
    await expect(
      buildController(stub).schedule({ ...VALID_BODY, smuggled: 1 }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects an inverted window (startsAt >= endsAt)', async () => {
    const stub = okStub(VALID_SCHEDULE_RESPONSE);
    await expect(
      buildController(stub).schedule(
        { ...VALID_BODY, startsAt: END_ISO, endsAt: NOW_ISO },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects an out-of-range boost', async () => {
    const stub = okStub(VALID_SCHEDULE_RESPONSE);
    await expect(
      buildController(stub).schedule(
        { ...VALID_BODY, boostMultiplier: 99 },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 503 when SEARCH_INDEX_API_KEY is unset', async () => {
    const stub = okStub(VALID_SCHEDULE_RESPONSE);
    await expect(
      buildController(stub, { ...ENV, SEARCH_INDEX_API_KEY: undefined }).schedule(
        VALID_BODY,
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('forwards a downstream 4xx verbatim', async () => {
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
    await expect(
      buildController(stub).schedule(VALID_BODY, undefined, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 422, response: downstreamBody });
  });
});

// ─────────────────────────────────────────────────────────────────────
// cancel()
// ─────────────────────────────────────────────────────────────────────

describe('AdminFeaturedPlacementsProxyController.cancel', () => {
  it('forwards the encoded placementId and returns the deleted outcome', async () => {
    const stub = okStub(VALID_DELETE_RESPONSE);
    const response = await buildController(stub).cancel('fp_abc', REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_DELETE_RESPONSE);
    expect(stub.lastOptions?.method).toBe('DELETE');
    expect(stub.lastOptions?.path).toBe('/api/v1/internal/search/featured-placements/fp_abc');
  });

  it('URL-encodes a slash-injection placementId', async () => {
    const stub = okStub(VALID_DELETE_RESPONSE);
    await buildController(stub).cancel('fp/../admin', REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe(
      '/api/v1/internal/search/featured-placements/fp%2F..%2Fadmin',
    );
  });

  it('forwards a downstream 4xx verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'placement not found',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: downstreamBody,
      setCookies: [],
    });
    await expect(buildController(stub).cancel('fp_ghost', REQUEST_WITH_CTX)).rejects.toMatchObject({
      status: 404,
      response: downstreamBody,
    });
  });

  it('throws 503 when SEARCH_INDEX_API_KEY is unset', async () => {
    const stub = okStub(VALID_DELETE_RESPONSE);
    await expect(
      buildController(stub, { ...ENV, SEARCH_INDEX_API_KEY: undefined }).cancel(
        'fp_abc',
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = okStub(VALID_DELETE_RESPONSE);
    await expect(
      buildController(stub).cancel('fp_abc', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
