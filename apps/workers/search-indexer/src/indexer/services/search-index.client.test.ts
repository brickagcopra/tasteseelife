import type { ProviderDiscoveryDocument } from '@taste-and-see/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../config/env';
import { SearchIndexClient, SearchIndexClientError } from './search-index.client';

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

function buildDocument(providerId: string): ProviderDiscoveryDocument {
  return {
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
  };
}

describe('SearchIndexClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PUTs the document to service-search with the shared-secret header', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          outcome: 'updated',
          providerId: 'prov_1',
          indexedAt: '2026-05-16T12:00:00.000Z',
          liveMode: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const client = new SearchIndexClient(buildEnv());
    const result = await client.upsert(buildDocument('prov_1'));

    expect(result.outcome).toBe('updated');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    if (!call) throw new Error('expected fetch call');
    const [url, init] = call;
    expect(url).toContain('/api/v1/internal/search/providers/prov_1');
    const reqInit = init as RequestInit | undefined;
    expect(reqInit?.method).toBe('PUT');
    const headers = reqInit?.headers as Record<string, string> | undefined;
    expect(headers?.['x-internal-api-key']).toBe('k'.repeat(48));
    expect(headers?.['content-type']).toBe('application/json');
    expect(typeof reqInit?.body).toBe('string');
    const parsedBody = JSON.parse(reqInit?.body as string) as {
      document: { providerId: string };
    };
    expect(parsedBody.document.providerId).toBe('prov_1');
  });

  it('throws SearchIndexClientError on a non-2xx response', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));

    const client = new SearchIndexClient(buildEnv());

    await expect(client.upsert(buildDocument('prov_1'))).rejects.toBeInstanceOf(
      SearchIndexClientError,
    );
  });

  it('throws SearchIndexClientError on a network failure', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockRejectedValueOnce(new Error('no route to host'));

    const client = new SearchIndexClient(buildEnv());

    await expect(client.upsert(buildDocument('prov_1'))).rejects.toBeInstanceOf(
      SearchIndexClientError,
    );
  });

  it('DELETEs the document by providerId', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          outcome: 'deleted',
          providerId: 'prov_1',
          deletedAt: '2026-05-16T12:00:00.000Z',
          liveMode: false,
        }),
        { status: 200 },
      ),
    );

    const client = new SearchIndexClient(buildEnv());
    const result = await client.remove('prov_1');

    expect(result.outcome).toBe('deleted');
    const call = mockFetch.mock.calls[0];
    if (!call) throw new Error('expected fetch call');
    const [, init] = call;
    expect((init as RequestInit | undefined)?.method).toBe('DELETE');
  });

  it('throws SearchIndexClientError on DELETE failure', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValueOnce(new Response('nope', { status: 503 }));

    const client = new SearchIndexClient(buildEnv());

    await expect(client.remove('prov_1')).rejects.toBeInstanceOf(SearchIndexClientError);
  });
});
