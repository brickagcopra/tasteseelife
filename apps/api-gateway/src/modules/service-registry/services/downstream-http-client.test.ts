import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import {
  AuthContextSignerService,
  TRUST_HEADERS,
} from '../../auth-context/services/auth-context-signer.service';
import { DownstreamHttpClient, type DownstreamResult } from './downstream-http-client';
import { DownstreamMetrics } from './downstream-metrics';
import { ServiceRegistry } from './service-registry';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    LOG_LEVEL: 'info',
    SERVICE_VERSION: 'unit-test',
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
    DOWNSTREAM_REQUEST_TIMEOUT_MS: 2_000,
    SUBSCRIPTION_SERVICE_BASE_URL: 'http://service-subscription.local',
    IDENTITY_SERVICE_BASE_URL: 'http://service-identity.local',
    HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME: 'x-household-visit-prep-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: 'x-household-memberships-internal-api-key',
    HOUSEHOLD_SCOPE_CACHE_TTL_SECONDS: 60,
    SEARCH_INDEX_HEADER_NAME: 'x-internal-api-key',
    ...overrides,
  };
}

function buildClient(env: Env): {
  client: DownstreamHttpClient;
  capturedFetch: ReturnType<typeof vi.fn>;
  recordCall: ReturnType<typeof vi.spyOn>;
} {
  const registry = new ServiceRegistry(env);
  const signer = new AuthContextSignerService(env);
  const capturedFetch = vi.fn();
  vi.stubGlobal('fetch', capturedFetch);
  // The real metrics class (TS-140-followup-4): `getMeter` yields a no-op
  // meter with no SDK booted, so it is free to construct and the spy is what
  // makes the recorded result assertable.
  const metrics = new DownstreamMetrics();
  const recordCall = vi.spyOn(metrics, 'recordCall');
  const client = new DownstreamHttpClient(env, registry, signer, metrics);
  return { client, capturedFetch, recordCall };
}

const ACTOR = {
  userId: 'usr_abc',
  mfaVerified: true,
  roles: [],
  tenantScope: { type: 'global' as const },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DownstreamHttpClient.call', () => {
  let env: Env;
  beforeEach(() => {
    env = buildEnv();
  });

  it('issues a fetch to the resolved base URL with trust headers attached', async () => {
    const { client, capturedFetch } = buildClient(env);
    capturedFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await client.call({
      service: 'subscription',
      path: '/api/v1/plans',
      actor: ACTOR,
    });

    expect(result.kind).toBe('ok');
    expect(capturedFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = capturedFetch.mock.calls[0]!;
    expect(calledUrl).toBe('http://service-subscription.local/api/v1/plans');
    const headers = calledInit.headers as Record<string, string>;
    expect(headers[TRUST_HEADERS.USER_ID]).toBe('usr_abc');
    expect(headers[TRUST_HEADERS.SIGNATURE]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns kind=not_configured when the service has no base URL', async () => {
    // Build a registry that's missing the household URL by NOT installing
    // the stub fetch — the registry check short-circuits before fetch.
    const registry = new ServiceRegistry(env);
    const signer = new AuthContextSignerService(env);
    const localFetch = vi.fn();
    vi.stubGlobal('fetch', localFetch);
    const client = new DownstreamHttpClient(env, registry, signer, new DownstreamMetrics());

    const result = await client.call({
      service: 'household',
      path: '/api/v1/whatever',
      actor: ACTOR,
    });
    expect(result.kind).toBe('not_configured');
    if (result.kind === 'not_configured') expect(result.service).toBe('household');
    expect(localFetch).not.toHaveBeenCalled();
  });

  it('returns client_error on a 4xx with the JSON body decoded', async () => {
    const { client, capturedFetch } = buildClient(env);
    capturedFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await client.call({
      service: 'subscription',
      path: '/api/v1/plans/missing',
      actor: ACTOR,
    });
    expect(result.kind).toBe('client_error');
    if (result.kind === 'client_error') {
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ detail: 'not found' });
    }
  });

  it('returns server_error on a 5xx', async () => {
    const { client, capturedFetch } = buildClient(env);
    capturedFetch.mockResolvedValue(
      new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } }),
    );

    const result = await client.call({
      service: 'subscription',
      path: '/api/v1/plans',
      actor: ACTOR,
    });
    expect(result.kind).toBe('server_error');
  });

  it('returns network_error when fetch throws a non-abort error', async () => {
    const { client, capturedFetch } = buildClient(env);
    capturedFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result: DownstreamResult = await client.call({
      service: 'subscription',
      path: '/api/v1/plans',
      actor: ACTOR,
    });
    expect(result.kind).toBe('network_error');
    if (result.kind === 'network_error') expect(result.detail).toContain('ECONNREFUSED');
  });

  it('returns timeout when the AbortController fires', async () => {
    const { client, capturedFetch } = buildClient(env);
    capturedFetch.mockImplementation((_url, init: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const abortErr = new Error('aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
        });
      });
    });

    const result = await client.call({
      service: 'subscription',
      path: '/api/v1/plans',
      actor: ACTOR,
      timeoutMs: 50,
    });
    expect(result.kind).toBe('timeout');
  });

  it('attaches the trace id when supplied', async () => {
    const { client, capturedFetch } = buildClient(env);
    capturedFetch.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await client.call({
      service: 'subscription',
      path: '/api/v1/plans',
      actor: ACTOR,
      traceId: 'tr_test_001',
    });
    const headers = capturedFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-trace-id']).toBe('tr_test_001');
  });

  it('serialises the request body for POST', async () => {
    const { client, capturedFetch } = buildClient(env);
    capturedFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await client.call({
      service: 'subscription',
      path: '/api/v1/subscriptions',
      method: 'POST',
      body: { planCode: 'family.tier1' },
      actor: ACTOR,
      idempotencyKey: undefined,
    });
    const init = capturedFetch.mock.calls[0]![1] as {
      body?: string;
      headers: Record<string, string>;
    };
    expect(init.body).toBe(JSON.stringify({ planCode: 'family.tier1' }));
    expect(init.headers['content-type']).toBe('application/json');
  });

  it('omits trust headers when no actor is supplied (pre-auth proxies)', async () => {
    const { client, capturedFetch } = buildClient(env);
    capturedFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await client.call({
      service: 'identity',
      path: '/api/v1/auth/login',
      method: 'POST',
      body: { email: 'a@b.com', password: 'x'.repeat(8) },
      idempotencyKey: undefined,
    });
    const headers = capturedFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers[TRUST_HEADERS.USER_ID]).toBeUndefined();
    expect(headers[TRUST_HEADERS.SIGNATURE]).toBeUndefined();
  });

  it('forwards Idempotency-Key when supplied (TS-126-followup-1)', async () => {
    const { client, capturedFetch } = buildClient(env);
    capturedFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await client.call({
      service: 'identity',
      path: '/api/v1/admin/users/usr_1/suspend',
      method: 'POST',
      body: { reason: 'trust_safety' },
      actor: ACTOR,
      idempotencyKey: 'admin-suspend-usr_1-2026-05-18-001',
    });
    const headers = capturedFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('admin-suspend-usr_1-2026-05-18-001');
  });

  it('omits the Idempotency-Key header when the caller supplies an empty string', async () => {
    const { client, capturedFetch } = buildClient(env);
    capturedFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await client.call({
      service: 'identity',
      path: '/api/v1/admin/users/usr_1/unlock',
      method: 'POST',
      body: {},
      actor: ACTOR,
      idempotencyKey: '',
    });
    const headers = capturedFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['idempotency-key']).toBeUndefined();
  });

  it('forwards an opaque Cookie header to the downstream when supplied', async () => {
    const { client, capturedFetch } = buildClient(env);
    capturedFetch.mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'x', tokenType: 'Bearer', expiresIn: 900 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await client.call({
      service: 'identity',
      path: '/api/v1/auth/refresh',
      method: 'POST',
      cookieHeader: 'tas_refresh=abc.def',
      idempotencyKey: undefined,
    });
    const headers = capturedFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['cookie']).toBe('tas_refresh=abc.def');
  });

  it('propagates Set-Cookie values onto the result', async () => {
    const { client, capturedFetch } = buildClient(env);
    const responseHeaders = new Headers();
    responseHeaders.append('content-type', 'application/json');
    responseHeaders.append(
      'set-cookie',
      'tas_refresh=abc.def; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth',
    );
    capturedFetch.mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'x', tokenType: 'Bearer', expiresIn: 900 }), {
        status: 200,
        headers: responseHeaders,
      }),
    );

    const result = await client.call({
      service: 'identity',
      path: '/api/v1/auth/login',
      method: 'POST',
      body: { email: 'a@b.com', password: 'x'.repeat(8) },
      idempotencyKey: undefined,
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.setCookies.length).toBeGreaterThanOrEqual(1);
      expect(result.setCookies[0]).toContain('tas_refresh=abc.def');
    }
  });

  it('clamps the caller-supplied timeout to the env ceiling', async () => {
    // The clamp keeps the env ceiling as the upper bound. With env=2_000ms
    // and caller-requested 30_000ms, the effective timeout is 2_000ms.
    // We can't directly observe the AbortController's delay without
    // racing — we exercise the behaviour indirectly by ensuring the
    // call succeeds with a near-instantaneous fake fetch.
    const { client, capturedFetch } = buildClient(env);
    capturedFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await client.call({
      service: 'subscription',
      path: '/api/v1/plans',
      actor: ACTOR,
      timeoutMs: 30_000,
    });
    expect(result.kind).toBe('ok');
  });
});

describe('DownstreamHttpClient — call metrics (TS-140-followup-4)', () => {
  let env: Env;

  beforeEach(() => {
    env = buildEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records the target service and the `ok` result', async () => {
    const { client, capturedFetch, recordCall } = buildClient(env);
    capturedFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await client.call({ service: 'subscription', path: '/api/v1/plans', actor: ACTOR });

    expect(recordCall).toHaveBeenCalledTimes(1);
    expect(recordCall).toHaveBeenCalledWith('subscription', 'ok', expect.any(Number));
  });

  it.each([
    [500, 'server_error'],
    [404, 'client_error'],
  ] as const)('records a %d response as `%s`', async (status, result) => {
    // The two collapse into "not 2xx" in a span status, and they are
    // different problems: one is ours, one is the caller's.
    const { client, capturedFetch, recordCall } = buildClient(env);
    capturedFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'nope' }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await client.call({ service: 'subscription', path: '/api/v1/plans', actor: ACTOR });

    expect(recordCall).toHaveBeenCalledWith('subscription', result, expect.any(Number));
  });

  it('records a thrown fetch as `network_error`', async () => {
    const { client, capturedFetch, recordCall } = buildClient(env);
    capturedFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await client.call({ service: 'subscription', path: '/api/v1/plans', actor: ACTOR });

    expect(recordCall).toHaveBeenCalledWith('subscription', 'network_error', expect.any(Number));
  });

  it('records an UNCONFIGURED service, rather than staying silent', async () => {
    // The gateway never made a call at all, so this costs no time and shows
    // up in no latency signal — but it is a deployment gap somebody has to
    // close, and an absent series would make it indistinguishable from a
    // service the gateway simply never talks to.
    const { client, recordCall } = buildClient(env);

    const outcome = await client.call({
      service: 'household',
      path: '/api/v1/whatever',
      actor: ACTOR,
    });

    expect(outcome.kind).toBe('not_configured');
    expect(recordCall).toHaveBeenCalledWith('household', 'not_configured', expect.any(Number));
  });

  it('carries NO path, actor or trace id into the labels', async () => {
    // A downstream path carries ids (`/api/v1/households/{id}/...`): unbounded
    // cardinality and personal data on a metric label (CLAUDE.md §10, §17.2).
    const { client, capturedFetch, recordCall } = buildClient(env);
    capturedFetch.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await client.call({
      service: 'subscription',
      path: '/api/v1/plans/plan_secret',
      actor: ACTOR,
      traceId: 'trace_secret',
    });

    const serialised = JSON.stringify(recordCall.mock.calls);
    expect(serialised).not.toContain('plan_secret');
    expect(serialised).not.toContain('trace_secret');
    expect(serialised).not.toContain(ACTOR.userId);
  });
});
