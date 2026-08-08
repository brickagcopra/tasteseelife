import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../config/env';
import { ProviderSnapshotClient, ProviderSnapshotClientError } from './provider-snapshot.client';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3051,
    LOG_LEVEL: 'info',
    SERVICE_VERSION: 'dev',
    // Required on `Env` because `.default(true)` makes the OUTPUT type
    // required even though the input is optional (TS-504-followup-2a-2).
    OTEL_TRACES_ENABLED: true,
    OTEL_METRICS_ENABLED: true,
    REDIS_URL: 'redis://localhost:6379',
    OUTBOX_CONSUMER_GROUP: 'worker-search-indexer',
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_MAX_ATTEMPTS: 10,
    OUTBOX_POLL_BLOCK_MS: 5000,
    OUTBOX_RECLAIM_IDLE_MS: 60000,
    OUTBOX_POLL_INTERVAL_MS: 1000,
    PROVIDER_SERVICE_BASE_URL: 'http://service-provider:3014',
    PROVIDER_DISCOVERY_INTERNAL_API_KEY: 'd'.repeat(48),
    PROVIDER_DISCOVERY_INTERNAL_HEADER_NAME: 'x-provider-discovery-internal-api-key',
    PROVIDER_REQUEST_TIMEOUT_MS: 5000,
    SEARCH_SERVICE_BASE_URL: 'http://service-search:3020',
    SEARCH_INDEX_API_KEY: 'k'.repeat(48),
    SEARCH_INDEX_HEADER_NAME: 'x-internal-api-key',
    SEARCH_REQUEST_TIMEOUT_MS: 5000,
    ...overrides,
  };
}

function buildDocumentJson(providerId: string): unknown {
  return {
    kind: 'found',
    document: {
      providerId,
      userId: `user_${providerId}`,
      displayName: 'Chef Ada',
      headline: null,
      bio: null,
      tier: 'certified',
      status: 'active',
      languages: [],
      specialties: [],
      cuisines: [],
      dietaryExpertise: [],
      certifications: ['ccc'],
      centroid: null,
      ratingAverage: null,
      ratingCount: 0,
      completedBookingCount: 0,
      profilePhotoKey: null,
      videoIntroKey: null,
      timeZone: 'America/New_York',
      availabilitySummary: null,
      sourceUpdatedAt: '2026-05-16T12:00:00.000Z',
    },
  };
}

describe('ProviderSnapshotClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns kind=invalid_request for empty providerId without making an HTTP call', async () => {
    const client = new ProviderSnapshotClient(buildEnv());
    const result = await client.fetch('');

    expect(result.kind).toBe('invalid_request');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns kind=invalid_request for providerId failing the regex', async () => {
    const client = new ProviderSnapshotClient(buildEnv());
    const result = await client.fetch('has spaces!');

    expect(result.kind).toBe('invalid_request');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns a parsed `found` response on 200', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(buildDocumentJson('prov_1')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const client = new ProviderSnapshotClient(buildEnv());
    const result = await client.fetch('prov_1');

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.response.kind).toBe('found');
    if (result.response.kind !== 'found') return;
    expect(result.response.document.providerId).toBe('prov_1');
    expect(result.response.document.tier).toBe('certified');
  });

  it('returns a `not_found` response when service-provider says so', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: 'not_found', providerId: 'prov_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const client = new ProviderSnapshotClient(buildEnv());
    const result = await client.fetch('prov_1');

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.response.kind).toBe('not_found');
  });

  it('attaches the shared-secret header on every call', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(buildDocumentJson('prov_1')), { status: 200 }),
    );

    const client = new ProviderSnapshotClient(buildEnv());
    await client.fetch('prov_1');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs).toBeDefined();
    if (!callArgs) return;
    const [url, init] = callArgs;
    expect(typeof url).toBe('string');
    expect(url).toContain('/api/v1/internal/providers/prov_1/discovery-snapshot');
    const reqInit = init as RequestInit | undefined;
    expect(reqInit?.method).toBe('GET');
    const headers = reqInit?.headers as Record<string, string> | undefined;
    expect(headers?.['x-provider-discovery-internal-api-key']).toBe('d'.repeat(48));
  });

  it('throws ProviderSnapshotClientError on a non-2xx response', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'forbidden' }), { status: 401 }),
    );

    const client = new ProviderSnapshotClient(buildEnv());

    await expect(client.fetch('prov_1')).rejects.toBeInstanceOf(ProviderSnapshotClientError);
  });

  it('throws ProviderSnapshotClientError on a malformed response body', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'wat' }), { status: 200 }));

    const client = new ProviderSnapshotClient(buildEnv());

    await expect(client.fetch('prov_1')).rejects.toBeInstanceOf(ProviderSnapshotClientError);
  });

  it('throws ProviderSnapshotClientError on a network failure', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockRejectedValueOnce(new Error('connection refused'));

    const client = new ProviderSnapshotClient(buildEnv());

    await expect(client.fetch('prov_1')).rejects.toBeInstanceOf(ProviderSnapshotClientError);
  });

  it('honours a custom header name configured via env', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(buildDocumentJson('prov_1')), { status: 200 }),
    );

    const client = new ProviderSnapshotClient(
      buildEnv({ PROVIDER_DISCOVERY_INTERNAL_HEADER_NAME: 'x-tns-discovery' }),
    );
    await client.fetch('prov_1');

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs).toBeDefined();
    if (!callArgs) return;
    const [, init] = callArgs;
    const headers = (init as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.['x-tns-discovery']).toBe('d'.repeat(48));
    expect(headers?.['x-provider-discovery-internal-api-key']).toBeUndefined();
  });
});
